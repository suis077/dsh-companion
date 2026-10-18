/**
 * Offline checks for step 4: the panel's routes and — most importantly — the
 * trust fence that keeps a shell-equipped model from bypassing the approval
 * gate by POSTing the route directly.
 *
 * The routes are exercised through a fake `webServer` that captures the handler,
 * plus fake request/response objects. Nothing touches the real web server.
 *
 * Run: node tools/check-routes.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { apply } from '../index.js'
import { requestRejection, isLoopbackHostname, isTrustedAuthority, headerValue, parseAuthority, readJsonBody } from '../lib/http.mjs'
import { CardStore } from '../lib/cards.mjs'

const failures = []
function check (label, ok, detail) {
  if (ok) { console.log(`  PASS  ${label}`); return }
  failures.push(label)
  console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-routes-'))
console.log(`dsh-companion route check\nworkdir: ${tmp}\n`)

/** Fake request: a stream plus headers/method/url. */
function fakeRequest ({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = headers
  req.destroy = () => {}
  if (body !== undefined) {
    Promise.resolve().then(() => {
      req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
      req.emit('end')
    })
  } else {
    Promise.resolve().then(() => req.emit('end'))
  }
  return req
}

/** Fake response recording status/headers/body. */
function fakeResponse () {
  const res = {
    status: 0,
    headers: {},
    chunks: [],
    writeHead (status, headers) { res.status = status; Object.assign(res.headers, headers ?? {}) },
    end (chunk) { if (chunk !== undefined) res.chunks.push(Buffer.from(String(chunk))) },
    get body () { return Buffer.concat(res.chunks).toString('utf8') },
    get json () { try { return JSON.parse(res.body) } catch { return undefined } },
  }
  return res
}

try {
  // ------------------------------------------------ pure fence helpers
  console.log('fence helpers')
  check('localhost is loopback', isLoopbackHostname('localhost') === true)
  check('127.0.0.1 is loopback', isLoopbackHostname('127.0.0.1') === true)
  check('127.255.255.255 is loopback', isLoopbackHostname('127.255.255.255') === true)
  check('127.0.0.256 is NOT loopback', isLoopbackHostname('127.0.0.256') === false)
  check('example.com is not loopback', isLoopbackHostname('example.com') === false)
  check('parses an authority', parseAuthority('127.0.0.1:8080')?.hostname === '127.0.0.1')
  check('rejects a broken authority', parseAuthority('::::') === undefined)
  check('trusted: exact port match', isTrustedAuthority(parseAuthority('192.168.1.9:3000'), ['192.168.1.9:3000']) === true)
  check('trusted: port-less entry matches any port', isTrustedAuthority(parseAuthority('192.168.1.9:9999'), ['192.168.1.9']) === true)
  check('untrusted host is refused', isTrustedAuthority(parseAuthority('evil.test:80'), ['192.168.1.9']) === false)
  check('headerValue works on a plain object', headerValue({ host: 'x' }, 'host') === 'x')
  check('headerValue works on Fetch Headers', headerValue({ get: (k) => (k === 'host' ? 'y' : undefined) }, 'host') === 'y')

  console.log('\nrequestRejection')
  check('allows a loopback request with a matching origin', requestRejection(fakeRequest({
    headers: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' },
  }), []) === undefined)
  check('allows loopback with no origin (same-origin fetch)', requestRejection(fakeRequest({ headers: { host: '127.0.0.1:19387' } }), []) === undefined)
  check('refuses a missing Host', requestRejection(fakeRequest({ headers: {} }), []) === 403)
  check('refuses a non-loopback host not in trustedHosts', requestRejection(fakeRequest({ headers: { host: 'evil.test' } }), []) === 403)
  check('refuses a cross-site request', requestRejection(fakeRequest({
    headers: { host: '127.0.0.1:1', 'sec-fetch-site': 'cross-site' },
  }), []) === 403)
  check('refuses a mismatched Origin', requestRejection(fakeRequest({
    headers: { host: '127.0.0.1:1', origin: 'http://evil.test' },
  }), []) === 403)
  check('refuses a malformed Origin', requestRejection(fakeRequest({
    headers: { host: '127.0.0.1:1', origin: 'not a url' },
  }), []) === 403)

  // ------------------------------------------------ readJsonBody
  console.log('\nreadJsonBody')
  check('parses an object body', JSON.stringify(await readJsonBody(fakeRequest({ body: { a: 1 } }))) === '{"a":1}')
  check('empty body -> {}', JSON.stringify(await readJsonBody(fakeRequest({}))) === '{}')
  check('invalid JSON -> {}', JSON.stringify(await readJsonBody(fakeRequest({ body: '{oops' }))) === '{}')
  check('array body -> {} (not a map)', JSON.stringify(await readJsonBody(fakeRequest({ body: '[1,2]' }))) === '{}')

  // ------------------------------------------------ the plugin's routes
  console.log('\nlive routes (with the harness gate present)')
  const hostDir = path.join(tmp, 'host')
  fs.mkdirSync(hostDir, { recursive: true })
  const store = new CardStore(hostDir)
  store.upsert({ id: 'testcard', name: '测试角色', systemPrompt: '测试角色甲。', trigger: '切回普通模式' })
  store.upsert({ id: 'other', name: '别的', systemPrompt: '你是别的。' })

  let captured
  const server = { register: (route) => { captured = route; return () => {} } }
  // A gate that allows everything EXCEPT requests flagged `hostile`.
  const connection = {
    requestRejection: (req) => (req.headers['x-test-hostile'] === '1' ? 403 : undefined),
  }
  const ctx = {
    logger: { warn: () => {}, error: () => {} },
    root: { get: (n) => (n === 'connection' ? connection : n === 'webServer' ? server : undefined) },
    inject: (deps, cb) => cb({
      get: (n) => (n === 'webServer' ? server : undefined),
      effect: (fn) => { fn(); return {} },
    }),
  }
  apply(ctx, { storeDir: hostDir })

  check('registered a prefix route', captured?.kind === 'prefix' && captured?.path === '/persona-card', JSON.stringify({ k: captured?.kind, p: captured?.path }))

  const get = async (url, headers = { host: '127.0.0.1:19387' }) => {
    const res = fakeResponse()
    await captured.handler(fakeRequest({ method: 'GET', url, headers }), res)
    return res
  }
  const post = async (url, body, headers = { host: '127.0.0.1:19387' }) => {
    const res = fakeResponse()
    await captured.handler(fakeRequest({ method: 'POST', url, headers, body }), res)
    return res
  }

  const s0 = await get('/persona-card/state?sessionId=session-a')
  check('GET /state returns 200', s0.status === 200, String(s0.status))
  check('  ...lists both cards', s0.json?.cards?.length === 2, JSON.stringify(s0.json?.cards))
  check('  ...reports no global card yet', s0.json?.activeCardId === '', JSON.stringify(s0.json?.activeCardId))
  check('  ...reports nothing injected', s0.json?.effectiveEnabled === false)
  // No card is active yet, so the state must not pretend there is a memory.
  check('  ...and reports no memory when no card is active', s0.json?.memory === undefined, JSON.stringify(s0.json?.memory))

  const set1 = await post('/persona-card/set', { action: 'setGlobal', cardId: 'testcard', sessionId: 'session-a' })
  check('POST setGlobal returns 200', set1.status === 200, set1.body.slice(0, 120))
  check('  ...global card is now testcard', set1.json?.activeCardId === 'testcard')
  check('  ...and it is reported as injected', set1.json?.effectiveEnabled === true, JSON.stringify(set1.json?.effectiveReason))
  // Once a card is active, its memory shows up in the state.
  check('  ...a memory object is now present', set1.json?.memory !== undefined, JSON.stringify(set1.json?.memory))
  check('  ...with a numeric affinity', Number.isFinite(set1.json?.memory?.affinity), JSON.stringify(set1.json?.memory?.affinity))
  check('  ...with a chapter count', Number.isFinite(set1.json?.memory?.count), JSON.stringify(set1.json?.memory?.count))

  const off = await post('/persona-card/set', { action: 'sessionOff', sessionId: 'session-a' })
  check('sessionOff disables session A', off.json?.effectiveEnabled === false && off.json?.effectiveReason === 'session-disabled', JSON.stringify(off.json?.effectiveReason))

  const other = await get('/persona-card/state?sessionId=session-b')
  check('session B is unaffected by session A turning off', other.json?.effectiveEnabled === true, JSON.stringify(other.json?.effectiveReason))

  const back = await post('/persona-card/set', { action: 'sessionFollow', sessionId: 'session-a' })
  check('sessionFollow restores session A', back.json?.effectiveEnabled === true)

  const setCard = await post('/persona-card/set', { action: 'setSessionCard', cardId: 'other', sessionId: 'session-a' })
  check('setSessionCard pins a per-session card', setCard.json?.effectiveCard === '别的', JSON.stringify(setCard.json?.effectiveCard))
  const bStill = await get('/persona-card/state?sessionId=session-b')
  check('  ...session B still uses the global card', bStill.json?.effectiveCard === '测试角色', JSON.stringify(bStill.json?.effectiveCard))

  const cleared = await post('/persona-card/set', { action: 'sessionClear', sessionId: 'session-a' })
  check('sessionClear returns to the global card', cleared.json?.effectiveCard === '测试角色')

  // ---- refusals ----
  console.log('\nrefusals')
  const hostile = await get('/persona-card/state?sessionId=session-a', { host: '127.0.0.1:1', 'x-test-hostile': '1' })
  check('a rejected request is refused with 403', hostile.status === 403, String(hostile.status))

  const noSession = await post('/persona-card/set', { action: 'sessionOff' })
  check('sessionOff without a sessionId is a 400, not a silent write', noSession.status === 400, noSession.body.slice(0, 120))

  const badAction = await post('/persona-card/set', { action: 'nonsense' })
  check('an unknown action is a 400', badAction.status === 400, badAction.body.slice(0, 120))

  const unknownRoute = await get('/persona-card/nope')
  check('an unknown route is a 404', unknownRoute.status === 404, String(unknownRoute.status))

  const badMethod = await post('/persona-card/state', {})
  check('POST to /state is a 405', badMethod.status === 405, String(badMethod.status))

  const badGlobal = await post('/persona-card/set', { action: 'setGlobal', cardId: 'ghost' })
  check('setting a nonexistent global card is a 400', badGlobal.status === 400, badGlobal.body.slice(0, 120))

  // ---- the critical one: no harness gate -> local fence still refuses ----
  console.log('\nfallback fence (no harness connection service)')
  let captured2
  const server2 = { register: (r) => { captured2 = r; return () => {} } }
  const ctx2 = {
    logger: { warn: () => {}, error: () => {} },
    root: { get: (n) => (n === 'webServer' ? server2 : undefined) },
    inject: (deps, cb) => cb({
      get: (n) => (n === 'webServer' ? server2 : undefined),
      effect: (fn) => { fn(); return {} },
    }),
  }
  apply(ctx2, { storeDir: path.join(tmp, 'host2') })

  const res2 = fakeResponse()
  await captured2.handler(
    fakeRequest({ method: 'POST', url: '/persona-card/set', headers: { host: 'evil.test' }, body: { action: 'setGlobal', cardId: 'testcard' } }),
    res2,
  )
  check('with no harness gate, a non-loopback Host is still refused', res2.status === 403, String(res2.status))

  const res3 = fakeResponse()
  await captured2.handler(
    fakeRequest({ method: 'GET', url: '/persona-card/state', headers: { host: '127.0.0.1:19387' } }),
    res3,
  )
  check('  ...while a loopback request still works', res3.status === 200, String(res3.status))

  // A throwing gate must refuse, not crash the route.
  let captured3
  const server3 = { register: (r) => { captured3 = r; return () => {} } }
  const ctx3 = {
    logger: { warn: () => {}, error: () => {} },
    root: { get: (n) => (n === 'connection' ? { requestRejection: () => { throw new Error('gate exploded') } } : n === 'webServer' ? server3 : undefined) },
    inject: (deps, cb) => cb({ get: (n) => (n === 'webServer' ? server3 : undefined), effect: (fn) => { fn(); return {} } }),
  }
  apply(ctx3, { storeDir: path.join(tmp, 'host3') })
  const res4 = fakeResponse()
  await captured3.handler(fakeRequest({ method: 'GET', url: '/persona-card/state', headers: { host: '127.0.0.1:1' } }), res4)
  check('a gate that throws fails closed (403), not open', res4.status === 403, String(res4.status))

  // A gate returning a non-number, non-undefined value must also fail closed.
  let captured4
  const server4 = { register: (r) => { captured4 = r; return () => {} } }
  const ctx4 = {
    logger: { warn: () => {}, error: () => {} },
    root: { get: (n) => (n === 'connection' ? { requestRejection: () => 'weird' } : n === 'webServer' ? server4 : undefined) },
    inject: (deps, cb) => cb({ get: (n) => (n === 'webServer' ? server4 : undefined), effect: (fn) => { fn(); return {} } }),
  }
  apply(ctx4, { storeDir: path.join(tmp, 'host4') })
  const res5 = fakeResponse()
  await captured4.handler(fakeRequest({ method: 'GET', url: '/persona-card/state', headers: { host: '127.0.0.1:1' } }), res5)
  check('a gate answering a non-status fails closed too', res5.status === 403, String(res5.status))
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.log(`\nRESULT: FAILED (${failures.length}) -> ${failures.join('; ')}`)
  process.exit(1)
}
console.log('\nRESULT: OK — all checks passed')
