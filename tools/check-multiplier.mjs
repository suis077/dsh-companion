/**
 * Offline checks for the credit-multiplier resolver.
 *
 * This is the module that decides whether a credit figure is trustworthy, so the
 * properties tested here are about refusing to guess:
 *   - a config override always wins;
 *   - a live lookup never leaves the machine;
 *   - a failed lookup yields "unknown", never 0;
 *   - concurrent callers share one request.
 *
 * `fetch` is injected, so nothing here touches the network.
 *
 * Run: node tools/check-multiplier.mjs
 */
import { MultiplierResolver, multipliersFromStatus, webOrigin, WORKBUDDY_USAGE_ROUTE } from '../lib/multiplier.mjs'

const failures = []
function check (label, ok, detail) {
  if (ok) { console.log(`  PASS  ${label}`); return }
  failures.push(label)
  console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

console.log('dsh-companion multiplier check\n')

// ---------------------------------------------------------------- origin
console.log('origin selection')
check('uses DSH_WEB_URL when loopback', webOrigin({ DSH_WEB_URL: 'http://127.0.0.1:19387' }) === 'http://127.0.0.1:19387')
check('accepts localhost', webOrigin({ DSH_WEB_URL: 'http://localhost:1234' }) === 'http://localhost:1234')
check('strips a path from the URL', webOrigin({ DSH_WEB_URL: 'http://127.0.0.1:19387/some/page' }) === 'http://127.0.0.1:19387')
check('REFUSES a non-loopback host', webOrigin({ DSH_WEB_URL: 'http://evil.test:80' }) === undefined, String(webOrigin({ DSH_WEB_URL: 'http://evil.test:80' })))
check('returns undefined when unset (never guesses a port)', webOrigin({}) === undefined, String(webOrigin({})))
// A hard-coded fallback was the actual bug: the port changes between launches,
// so the guess silently pointed at a dead port after an update.
check('a port in DSH_WEB_URL is preserved verbatim', webOrigin({ DSH_WEB_URL: 'http://127.0.0.1:64622' }) === 'http://127.0.0.1:64622')
check('a malformed URL is refused', webOrigin({ DSH_WEB_URL: 'not a url' }) === undefined)
check('the route path is the WorkBuddy one', WORKBUDDY_USAGE_ROUTE === '/plugins/dsh-connect-workbuddy/usage')

// ---------------------------------------------------------------- parsing
console.log('\nstatus parsing')
const doc = {
  models: [{ id: 'a', creditMultiplier: 0.11 }, { id: 'b', creditMultiplier: 0 }],
  catalog: [{ id: 'a', creditMultiplier: 0.5 }],
  pool: { catalog: [{ id: 'c', creditMultiplier: 0.79 }] },
}
const table = multipliersFromStatus(doc)
check('reads models[].id', table.a !== undefined)
check('reads a 0 multiplier as 0 (free is not unknown)', table.b === 0)
check('reads catalog[]', Object.keys(multipliersFromStatus({ catalog: [{ id: 'z', creditMultiplier: 2 }] })).length === 1)
check('reads pool.catalog[]', table.c === 0.79, String(table.c))
check('ignores entries with no id', Object.keys(multipliersFromStatus({ models: [{ creditMultiplier: 1 }] })).length === 0)
check('ignores a non-numeric multiplier', Object.keys(multipliersFromStatus({ models: [{ id: 'x', creditMultiplier: 'high' }] })).length === 0)
check('ignores a negative multiplier', Object.keys(multipliersFromStatus({ models: [{ id: 'x', creditMultiplier: -1 }] })).length === 0)
check('handles a junk document', Object.keys(multipliersFromStatus(null)).length === 0 && Object.keys(multipliersFromStatus('x')).length === 0)

// ---------------------------------------------------------------- overriding
console.log('\nconfig overrides win')
{
  const r = new MultiplierResolver({ overrides: { m: 0.5 } })
  check('an override is returned without any network call', r.lookup('m') === 0.5, String(r.lookup('m')))
  check('an override of 0 is honoured (free)', new MultiplierResolver({ overrides: { m: 0 } }).lookup('m') === 0)
  check('an invalid override is ignored', new MultiplierResolver({ overrides: { m: -1 } }).lookup('m') === undefined)
}

// ---------------------------------------------------------------- live lookup
console.log('\nlive lookup')
{
  let calls = 0
  let seenUrl
  const fetchImpl = async (url) => {
    calls += 1
    seenUrl = url
    return { ok: true, json: async () => ({ models: [{ id: 'deepseek-v4.1-flash', creditMultiplier: 0.11 }] }) }
  }
  const r = new MultiplierResolver({ env: { DSH_WEB_URL: 'http://127.0.0.1:19387' }, fetchImpl })
  const res = await r.refresh()
  check('refresh succeeds', res.ok === true, JSON.stringify(res))
  check('  ...and asks the local route', seenUrl === 'http://127.0.0.1:19387' + WORKBUDDY_USAGE_ROUTE, String(seenUrl))
  check('  ...one request', calls === 1, String(calls))
  check('lookup then resolves', r.lookup('deepseek-v4.1-flash') === 0.11, String(r.lookup('deepseek-v4.1-flash')))
  check('an unknown model still yields undefined', r.lookup('nope') === undefined)
  check('the cache is fresh right after', r.fresh === true)

  // A second lookup inside the TTL must not re-fetch.
  r.lookup('deepseek-v4.1-flash')
  check('a cached lookup does not re-fetch', calls === 1, String(calls))

  // Concurrent refreshes share one request.
  const slow = new MultiplierResolver({
    env: { DSH_WEB_URL: 'http://127.0.0.1:1' },
    fetchImpl: async () => { await new Promise((r2) => setTimeout(r2, 10)); return { ok: true, json: async () => ({ models: [{ id: 'm', creditMultiplier: 1 }] }) } },
  })
  await Promise.all([slow.refresh(), slow.refresh(), slow.refresh()])
  check('concurrent refreshes do not stampede', slow.lookup('m') === 1)
}

// ---------------------------------------------------------------- failure modes
console.log('\nfailure modes must yield UNKNOWN, never 0')
{
  const http500 = new MultiplierResolver({ env: { DSH_WEB_URL: 'http://127.0.0.1:1' }, fetchImpl: async () => ({ ok: false, status: 500 }) })
  const res = await http500.refresh()
  check('a non-200 is reported as a problem', res.ok === false && res.problem.includes('500'), JSON.stringify(res))
  check('  ...and lookup is undefined, not 0', http500.lookup('anything') === undefined)

  const throwing = new MultiplierResolver({ env: { DSH_WEB_URL: 'http://127.0.0.1:1' }, fetchImpl: async () => { throw new Error('boom') } })
  const r2 = await throwing.refresh()
  check('a thrown fetch is caught', r2.ok === false, JSON.stringify(r2))
  check('  ...and lookup is undefined', throwing.lookup('x') === undefined)

  const empty = new MultiplierResolver({ env: { DSH_WEB_URL: 'http://127.0.0.1:1' }, fetchImpl: async () => ({ ok: true, json: async () => ({ models: [] }) }) })
  const r3 = await empty.refresh()
  check('an empty catalog is a problem, not an empty success', r3.ok === false, JSON.stringify(r3))
  check('  ...and the message says why', r3.problem.includes('倍率'), r3.problem)

  const offline = new MultiplierResolver({ env: { DSH_WEB_URL: 'http://127.0.0.1:1' }, fetchImpl: undefined })
  check('no fetch available is reported', (await offline.refresh()).ok === false)
  check('a non-loopback origin is refused', (await new MultiplierResolver({ env: { DSH_WEB_URL: 'http://evil.test' }, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }).refresh()).ok === false)
  check('a bad JSON body is caught', (await new MultiplierResolver({ env: { DSH_WEB_URL: 'http://127.0.0.1:1' }, fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('bad json') } }) }).refresh()).ok === false)
}

// ---------------------------------------------------------------- the real value
console.log('\nreal-world value (from the live route, recorded)')
{
  // The live route reported this for the model this session used. Hard-coded as
  // a regression anchor: if the formula or parsing drifts, this catches it.
  const r = new MultiplierResolver({
    env: { DSH_WEB_URL: 'http://127.0.0.1:1' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ models: [{ id: 'deepseek-v4.1-flash', creditMultiplier: 0.11 }, { id: 'hy3', creditMultiplier: 0 }] }) }),
  })
  await r.refresh()
  check('deepseek-v4.1-flash resolves to 0.11', r.lookup('deepseek-v4.1-flash') === 0.11)
  check('hy3 resolves to 0 (a real free model)', r.lookup('hy3') === 0)
  const tokens = 67555295
  const credits = (tokens / 1e6) * r.lookup('deepseek-v4.1-flash')
  check('this session\'s total is ~7.43 credits', Math.abs(credits - 7.43108245) < 1e-6, String(credits))
}

// ---------------------------------------------------------------- cold start
console.log('\ncold start (the bug that shipped)')
{
  // A resolver that has never refreshed reads as an EMPTY table. The panel used
  // to call `table()` without ever calling `refresh()`, so it reported "倍率表为空
  // (workbuddy 未安装或未登录？)" on a perfectly healthy install — the lookup was
  // simply never started. This pins the two distinct states apart.
  let fetched = 0
  const r = new MultiplierResolver({
    env: { DSH_WEB_URL: 'http://127.0.0.1:1' },
    fetchImpl: async () => {
      fetched += 1
      return { ok: true, json: async () => ({ models: [{ id: 'm', creditMultiplier: 0.11 }] }) }
    },
  })

  check('a never-refreshed resolver has an empty table', Object.keys(r.table()).length === 0)
  check('  ...and is not "fresh"', r.fresh === false)
  check('  ...and has no lastProblem yet (it never tried)', r.lastProblem === undefined,
    JSON.stringify(r.lastProblem))

  // Refresh is what fills it — this is the call the panel was missing.
  await r.refresh()
  check('after refresh the table is populated', Object.keys(r.table()).length === 1, JSON.stringify(r.table()))
  check('  ...and the lookup resolves', r.lookup('m') === 0.11)
  check('  ...one fetch for one refresh', fetched === 1, String(fetched))

  // A FAILED refresh must leave a problem, so the panel can tell "not tried /
  // still loading" from "tried and failed".
  const bad = new MultiplierResolver({
    env: { DSH_WEB_URL: 'http://127.0.0.1:1' },
    fetchImpl: async () => ({ ok: false, status: 503 }),
  })
  check('a resolver that never tried has no problem', bad.lastProblem === undefined)
  await bad.refresh()
  check('a failed refresh records a problem', typeof bad.lastProblem === 'string', String(bad.lastProblem))
  check('  ...so "loading" and "failed" are distinguishable', bad.lastProblem !== undefined)
}

// ---------------------------------------------------------------- origin source
console.log('\norigin source (the bug that reached the user)')
{
  // The host process does NOT receive DSH_WEB_URL — only the model's shell does.
  // So `originFn` (backed by ctx.webServer.getOrigin()) must be the primary
  // source, and a resolver without either must name BOTH in its diagnostic.
  let seenUrl
  const withFn = new MultiplierResolver({
    originFn: () => 'http://127.0.0.1:62870',
    env: {}, // deliberately no DSH_WEB_URL, exactly like the host process
    fetchImpl: async (url) => { seenUrl = url; return { ok: true, json: async () => ({ models: [{ id: 'm', creditMultiplier: 0.11 }] }) } },
  })
  const r1 = await withFn.refresh()
  check('originFn alone is enough (no env var needed)', r1.ok === true, JSON.stringify(r1))
  check('  ...and it is the origin actually queried', seenUrl === 'http://127.0.0.1:62870' + WORKBUDDY_USAGE_ROUTE, String(seenUrl))

  // A throwing originFn (getOrigin before the port binds) must fall back, not crash.
  const throwing = new MultiplierResolver({
    originFn: () => { throw new Error('origin read before the listener bound a port') },
    env: { DSH_WEB_URL: 'http://127.0.0.1:1234' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ models: [{ id: 'm', creditMultiplier: 0.5 }] }) }),
  })
  check('a throwing originFn falls back to the env var', (await throwing.refresh()).ok === true)
  check('  ...and uses the env origin', throwing.lookup('m') === 0.5)

  // With neither source, the message must name BOTH so nobody chases the wrong one.
  const neither = new MultiplierResolver({
    originFn: () => undefined,
    env: {},
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  })
  const r3 = await neither.refresh()
  check('no origin at all fails', r3.ok === false)
  check('  ...and the problem names getOrigin()', r3.problem.includes('getOrigin'), r3.problem)
  check('  ...and also names DSH_WEB_URL', r3.problem.includes('DSH_WEB_URL'), r3.problem)

  // A trailing slash must not produce a double slash before the route.
  const slash = new MultiplierResolver({
    originFn: () => 'http://127.0.0.1:1/',
    env: {},
    fetchImpl: async (url) => { seenUrl = url; return { ok: true, json: async () => ({ models: [{ id: 'm', creditMultiplier: 1 }] }) } },
  })
  await slash.refresh()
  check('a trailing slash is normalised', seenUrl === 'http://127.0.0.1:1' + WORKBUDDY_USAGE_ROUTE, String(seenUrl))
}

// ---------------------------------------------------------------- current model
console.log('\ncurrent-model lookup (must name ONE model, or none)')
{
  // The panel must report the model this session is using — read from the agent's
  // own options, the way the harness registers its prompt variables. Reporting
  // arbitrary table entries was the bug: it listed hy4-preview / hy3 / hy3-x,
  // three models the user had never selected.
  const mkAgents = (agent) => ({ get: (id) => (id === 'session-x' ? agent : undefined) })
  const r = new MultiplierResolver({
    originFn: () => 'http://127.0.0.1:1',
    env: {},
    fetchImpl: async () => ({ ok: true, json: async () => ({ models: [{ id: 'deepseek-v4.1-flash', creditMultiplier: 0.11 }, { id: 'hy3', creditMultiplier: 0 }] }) }),
  })
  await r.refresh()

  // Mirrors what index.js does: ask the agent, then look up that model.
  const resolveCurrent = (agents, sessionId) => {
    try {
      const agent = agents.get?.(sessionId)
      const model = agent?.options?.model
      const provider = agent?.options?.provider
      if (typeof model !== 'string' || model === '') return undefined
      return { model, provider: typeof provider === 'string' ? provider : '', multiplier: r.lookup(model) }
    } catch { return undefined }
  }

  const cur = resolveCurrent(mkAgents({ options: { model: 'deepseek-v4.1-flash', provider: 'workbuddy' } }), 'session-x')
  check('the current model is read from agent.options', cur?.model === 'deepseek-v4.1-flash', JSON.stringify(cur))
  check('  ...the provider comes with it', cur?.provider === 'workbuddy', JSON.stringify(cur))
  check('  ...and its multiplier is resolved', cur?.multiplier === 0.11, JSON.stringify(cur))

  check('an unknown session yields undefined (no guessing)', resolveCurrent(mkAgents(undefined), 'nope') === undefined)
  check('a session with no model yields undefined', resolveCurrent(mkAgents({ options: {} }), 'session-x') === undefined)
  check('a throwing agents service is swallowed', (() => {
    try { resolveCurrent({ get: () => { throw new Error('boom') } }, 'session-x'); return true } catch { return false }
  })() === true)

  // A model missing from the table must NOT fall back to some other entry.
  const missing = resolveCurrent(mkAgents({ options: { model: 'not-in-table', provider: 'workbuddy' } }), 'session-x')
  check('a model absent from the table has NO multiplier', missing?.multiplier === undefined, JSON.stringify(missing))
  check('  ...but still reports which model it is', missing?.model === 'not-in-table')
}

if (failures.length > 0) {
  console.log(`\nRESULT: FAILED (${failures.length}) -> ${failures.join('; ')}`)
  process.exit(1)
}
console.log('\nRESULT: OK — all checks passed')
