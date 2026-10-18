/**
 * dsh-persona-card — route trust fence.
 *
 * WHY THIS FILE EXISTS, and the reason it is a faithful restatement rather than
 * something clever of our own:
 *
 * The panel's routes write host state (which card is active, per-session
 * overrides). The model has a shell. Without a fence, the model could simply
 * POST the route and bypass the approval gate that guards every other write
 * path — the exact hole dsh-todo-board documents in its own source:
 *
 *   "an AI with a shell could POST the board route directly and bypass the
 *    approval gate on the tool entirely"
 *
 * So the fence is borrowed from the harness rather than invented. The harness
 * gate (`connection.requestRejection`) is preferred because it is the whole
 * rule — trusted Host/Origin AND "did we hand this browser a session?" — and it
 * keeps working when DSH changes how it authenticates. The local restatement is
 * the fallback for a deployment without `dsh-client-connection`; it covers the
 * Host/Origin half only, which is why it must never be the first choice.
 *
 * Both return the same shape — a status to refuse with, or `undefined` to allow
 * — so nothing downstream cares which one answered.
 */

/** Parse a `hostname[:port]` authority; undefined when unparsable. */
export function parseAuthority (authority) {
  try {
    return new URL('http://' + authority)
  } catch {
    return undefined
  }
}

/** Canonical `hostname[:port]`, default ports stripped. */
function canonicalAuthority (entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL('https://' + entry).port
  return port === '' ? entryUrl.hostname : entryUrl.hostname + ':' + port
}

/** localhost, [::1], or 127.0.0.0/8. */
export function isLoopbackHostname (hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

/**
 * Whether a request authority matches a declared trusted entry.
 *
 * Mirrors the harness rule: an entry with an explicit port matches that exact
 * authority; a port-less entry matches the hostname on any port.
 */
export function isTrustedAuthority (hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/** One header by lowercased name, from Node's headers object or Fetch Headers. */
export function headerValue (headers, wanted) {
  if (headers === undefined || headers === null) return undefined
  if (typeof headers.get === 'function') {
    const got = headers.get(wanted)
    return typeof got === 'string' ? got : undefined
  }
  const found = headers[wanted]
  return typeof found === 'string' ? found : undefined
}

/**
 * Decide whether one request may reach a plugin route.
 *
 * @returns the HTTP status to refuse with, or `undefined` to allow.
 */
export function requestRejection (request, trustedHosts) {
  const headers = request === undefined || request === null ? undefined : request.headers
  const host = headerValue(headers, 'host')
  if (host === undefined) return 403
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return 403
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return 403
  if (headerValue(headers, 'sec-fetch-site') === 'cross-site') return 403
  const origin = headerValue(headers, 'origin')
  if (origin === undefined) return undefined
  try {
    return new URL(origin).host === hostUrl.host ? undefined : 403
  } catch {
    return 403
  }
}

/**
 * Build the `refuseUntrusted(request, response, label)` helper for one plugin.
 *
 * `contexts` is searched in order, each together with its `.root`. Two sources
 * are passed on purpose: the injected host context and the plugin's own
 * context. They should resolve the same services, but if one of them cannot see
 * `connection` (a narrower scope, an early load) the other still supplies the
 * real gate — and silently degrading to the weaker local fence is exactly the
 * failure mode this fence exists to prevent.
 *
 * @param {Array<object>} contexts - plugin contexts, most specific first.
 * @param {(level: string, message: string) => void} [log]
 * @returns {(request: any, response: any, label: string) => boolean} true when the response is already sent.
 */
export function makeRefusal (contexts, log = () => {}) {
  let refusalsLogged = 0
  const sources = (Array.isArray(contexts) ? contexts : [contexts]).filter(Boolean)

  /** Every context to consult, each with its root. */
  function candidates () {
    const out = []
    for (const source of sources) {
      out.push(source)
      try {
        if (source.root !== undefined && source.root !== source) out.push(source.root)
      } catch {
        /* a context whose root getter throws is simply not a candidate */
      }
    }
    return out
  }

  /** The harness' own gate, when this deployment has one. */
  function harnessConnection () {
    for (const source of candidates()) {
      try {
        if (typeof source.get !== 'function') continue
        const connection = source.get('connection')
        if (connection === undefined || connection === null) continue
        if (typeof connection.requestRejection !== 'function') continue
        return connection
      } catch {
        /* fall through to the next source */
      }
    }
    return undefined
  }

  /** Declared trusted hosts, or [] when the deployment does not say. */
  function trustedHosts () {
    for (const source of candidates()) {
      try {
        if (typeof source.get !== 'function') continue
        const runtime = source.get('webRuntime')
        const hosts = runtime === undefined || runtime === null ? undefined : runtime.trustedHosts
        if (Array.isArray(hosts)) return hosts
      } catch {
        /* fall through to the next source */
      }
    }
    return []
  }

  return function refuseUntrusted (request, response, label) {
    const connection = harnessConnection()
    let status
    let fence = 'harness'
    if (connection === undefined) {
      fence = 'local'
      status = requestRejection(request, trustedHosts())
    } else {
      try {
        status = connection.requestRejection(request)
      } catch (err) {
        // A gate that throws must refuse, not take the route down.
        log('error', `persona-card: 信任校验抛错，按拒绝处理（${label}）: ${String(err?.message ?? err)}`)
        status = 403
      }
      // Only `undefined` means allow. Fail closed on anything else.
      if (status !== undefined && typeof status !== 'number') status = 403
    }
    if (status === undefined) return false
    if (refusalsLogged < 20) {
      refusalsLogged += 1
      const headers = request === undefined || request === null ? undefined : request.headers
      log(
        'warn',
        `persona-card: 拒绝了未通过信任校验的请求（${label}，${fence}，status=${status}` +
          `，host=${String(headerValue(headers, 'host') ?? '(无)')}` +
          `，origin=${String(headerValue(headers, 'origin') ?? '(无)')}` +
          `，sec-fetch-site=${String(headerValue(headers, 'sec-fetch-site') ?? '(无)')}）`,
      )
    }
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(status === 401 ? 'unauthorized' : 'forbidden')
    return true
  }
}

/**
 * Read a JSON request body with a size cap, so a hostile caller cannot make the
 * host allocate without bound.
 *
 * @param {any} request
 * @param {number} [limit]
 * @returns {Promise<object>} parsed object, or {} when absent/invalid/oversized.
 */
export async function readJsonBody (request, limit = 64 * 1024) {
  return await new Promise((resolve) => {
    let size = 0
    const chunks = []
    let settled = false
    const done = (value) => { if (!settled) { settled = true; resolve(value) } }
    try {
      request.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) { done({}); try { request.destroy() } catch {} return }
        chunks.push(chunk)
      })
      request.on('end', () => {
        if (chunks.length === 0) return done({})
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          done(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {})
        } catch {
          done({})
        }
      })
      request.on('error', () => done({}))
    } catch {
      done({})
    }
  })
}

/** Send one JSON response. */
export function sendJson (response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}
