/**
 * dsh-persona-card — credit multiplier lookup.
 *
 * To turn tokens into credits we need the per-model `creditMultiplier`. Where it
 * can come from, in order of trust:
 *
 *   1. an explicit `multipliers` config on this plugin — always wins, so a user
 *      can correct a wrong value without editing any vendor code;
 *   2. the live WorkBuddy status route (`/plugins/dsh-connect-workbuddy/usage`),
 *      which reports the multiplier the upstream currently declares. This is the
 *      authoritative source: the profile's saved catalog goes stale (it listed
 *      `deepseek-v4.1-flash` at 0 while the live route reports 0.11);
 *   3. nothing. Returning `undefined` is a real answer — the caller then reports
 *      an incomplete credit total instead of a confident wrong number.
 *
 * The route is a loopback GET and needs no credential (verified: it answers 200
 * to a plain request with the Host header set to the local address). It is read
 * on a TTL because the endpoint proxies to the upstream and is not free to call
 * on every request.
 */

/** Cache lifetime for the live catalog. */
const TTL_MS = 60_000

/**
 * Resolve the local Harness web origin.
 *
 * `DSH_WEB_URL` is set in a profile-launched Harness and is the only reliable
 * source: the port is chosen at launch and CHANGES between launches (observed
 * 19387 one day, 64622 the next after an update). A hard-coded fallback was
 * therefore worse than none — after an update it silently pointed at a dead port
 * and the panel reported the multiplier as unknown for a reason nobody could
 * see. With no variable, we say so instead of guessing.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | undefined}
 */
export function webOrigin (env = process.env) {
  const raw = typeof env.DSH_WEB_URL === 'string' ? env.DSH_WEB_URL.trim() : ''
  if (raw === '') return undefined
  try {
    const u = new URL(raw)
    // Only ever talk to this machine: a multiplier is not worth sending a
    // request off-box, and the route would refuse a non-loopback origin anyway.
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost' && u.hostname !== '[::1]') return undefined
    return u.origin
  } catch {
    return undefined
  }
}

/** The WorkBuddy status route owned by dsh-connect-workbuddy. */
export const WORKBUDDY_USAGE_ROUTE = '/plugins/dsh-connect-workbuddy/usage'

/**
 * Pull `{ id → creditMultiplier }` out of a WorkBuddy status document.
 *
 * Reads the CN and global model lists together: a model can appear in either,
 * and the multiplier we want is the one the region actually serving this
 * session declares. When both list the same id, the CN value wins only because
 * `Object.assign` order is explicit here — the live route reports one active
 * region's catalog under `models`, and that is the one that matters.
 *
 * @param {any} doc - the parsed status document.
 * @returns {Record<string, number>}
 */
export function multipliersFromStatus (doc) {
  const out = {}
  const lists = []
  if (Array.isArray(doc?.models)) lists.push(doc.models)
  if (Array.isArray(doc?.catalog)) lists.push(doc.catalog)
  if (Array.isArray(doc?.pool?.catalog)) lists.push(doc.pool.catalog)
  for (const list of lists) {
    for (const m of list) {
      const id = typeof m?.id === 'string' ? m.id : undefined
      const mult = m?.creditMultiplier
      if (id !== undefined && Number.isFinite(mult) && mult >= 0) out[id] = mult
    }
  }
  return out
}

/**
 * A multiplier resolver with a TTL cache.
 *
 * `lookup(model)` is synchronous by design: it is called from prompt assembly
 * and from the tool, neither of which can await. It returns whatever the cache
 * holds and refreshes in the background, so the first call after a cold start
 * reports "unknown" rather than blocking a turn on the network.
 */
export class MultiplierResolver {
  /**
   * @param {object} [options]
   * @param {Record<string, number>} [options.overrides] - config wins over the route.
   * @param {NodeJS.ProcessEnv} [options.env]
   * @param {() => string | undefined} [options.originFn] - resolves the local
   *   Harness origin. The PLUGIN passes `() => ctx.webServer.getOrigin()` here;
   *   this is the only reliable source, because `DSH_WEB_URL` is set for the
   *   model's shell process and NOT for the plugin host process (verified:
   *   process.env has no DSH_WEB_URL inside the host, while the shell has it).
   * @param {typeof fetch} [options.fetchImpl] - injectable for tests.
   * @param {(msg: string) => void} [options.log]
   */
  constructor (options = {}) {
    this.overrides = options.overrides !== null && typeof options.overrides === 'object' ? options.overrides : {}
    this.env = options.env ?? process.env
    this.originFn = typeof options.originFn === 'function' ? options.originFn : undefined
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.log = typeof options.log === 'function' ? options.log : () => {}
    this.cache = {}
    this.fetchedAt = 0
    this.inFlight = undefined
    this.lastProblem = undefined
  }

  /**
   * The origin to query, preferring the harness's own answer.
   *
   * Order matters: `ctx.webServer.getOrigin()` knows the port the server is
   * actually listening on, including an OS-assigned one, while `DSH_WEB_URL` is
   * a shell variable that the host process does not see at all.
   *
   * @returns {string | undefined}
   */
  resolveOrigin () {
    if (this.originFn !== undefined) {
      try {
        const got = this.originFn()
        if (typeof got === 'string' && got.trim() !== '') return got.replace(/\/+$/, '')
      } catch {
        /* fall through to the environment */
      }
    }
    return webOrigin(this.env)
  }

  /** Whether the cache is still fresh. */
  get fresh () {
    return this.fetchedAt > 0 && Date.now() - this.fetchedAt < TTL_MS
  }

  /**
   * The multiplier for one model, or undefined when unknown.
   *
   * @param {string} model
   * @returns {number | undefined}
   */
  lookup (model) {
    if (typeof model === 'string' && Object.hasOwn(this.overrides, model)) {
      const v = this.overrides[model]
      if (Number.isFinite(v) && v >= 0) return v
    }
    if (!this.fresh) this.refresh()
    const v = this.cache[model]
    return Number.isFinite(v) ? v : undefined
  }

  /** The whole cached table, for display. */
  table () {
    return { ...this.cache }
  }

  /**
   * Refresh from the live route. Safe to call repeatedly: concurrent callers
   * share one request, and failures are recorded rather than thrown.
   *
   * @returns {Promise<{ok: boolean, problem?: string}>}
   */
  async refresh () {
    if (this.inFlight !== undefined) return await this.inFlight
    const origin = this.resolveOrigin()
    if (origin === undefined) {
      // Say exactly what was missing. The previous wording blamed a non-local
      // DSH_WEB_URL, which sent the user looking at the wrong thing: in this
      // deployment the host process simply does not receive that variable at all.
      this.lastProblem = '取不到本机 Web 地址（ctx.webServer.getOrigin() 未就绪，且宿主进程没有 DSH_WEB_URL）'
      return { ok: false, problem: this.lastProblem }
    }
    if (typeof this.fetchImpl !== 'function') {
      this.lastProblem = '当前 Node 没有 fetch'
      return { ok: false, problem: this.lastProblem }
    }
    const url = origin + WORKBUDDY_USAGE_ROUTE
    this.inFlight = (async () => {
      try {
        const res = await this.fetchImpl(url, { headers: { accept: 'application/json' } })
        if (!res.ok) {
          this.lastProblem = `倍率接口返回 HTTP ${res.status}`
          return { ok: false, problem: this.lastProblem }
        }
        const doc = await res.json()
        const table = multipliersFromStatus(doc)
        if (Object.keys(table).length === 0) {
          this.lastProblem = '倍率接口没有给出任何模型倍率（workbuddy 未安装或未登录？）'
          return { ok: false, problem: this.lastProblem }
        }
        this.cache = table
        this.fetchedAt = Date.now()
        this.lastProblem = undefined
        return { ok: true }
      } catch (err) {
        this.lastProblem = `倍率查询失败：${String(err?.message ?? err)}`
        return { ok: false, problem: this.lastProblem }
      } finally {
        this.inFlight = undefined
      }
    })()
    return await this.inFlight
  }
}
