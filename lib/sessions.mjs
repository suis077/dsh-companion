/**
 * dsh-companion — per-session overrides.
 *
 * The card store answers "which card is globally active". This module answers
 * the narrower question "for THIS session, should a card be injected, and which
 * one" — so a session where you are writing code can opt out without changing
 * the global default for every other session.
 *
 * Layout:
 *   <storeDir>/sessions.json   { version, sessions: { <sessionId>: { enabled, cardId } } }
 *
 * `enabled: true`  -> inject the card named by `cardId`, or the global one.
 * `enabled: false` -> inject nothing for this session.
 * No entry         -> follow the global default.
 *
 * Like the card store, writes are atomic and the file is plain JSON so the user
 * can edit it by hand.
 */
import fs from 'node:fs'
import path from 'node:path'

export const SESSIONS_VERSION = 1

/** Session ids are opaque, but must stay usable as a JSON key. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/

/**
 * Normalise one override entry. Returns undefined for anything unusable so a
 * hand-edited typo degrades to "follow the global default" instead of throwing
 * during prompt assembly.
 *
 * @param {unknown} value
 * @returns {{enabled: boolean, cardId?: string} | undefined}
 */
export function normaliseOverride (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const v = /** @type {Record<string, unknown>} */ (value)
  if (typeof v.enabled !== 'boolean') return undefined
  const out = { enabled: v.enabled }
  if (typeof v.cardId === 'string' && v.cardId.trim() !== '') out.cardId = v.cardId
  return out
}

export class SessionOverrides {
  /** @param {string} storeDir - the same directory the card store uses. */
  constructor (storeDir) {
    if (typeof storeDir !== 'string' || storeDir.trim() === '') throw new TypeError('SessionOverrides requires a directory')
    this.dir = storeDir
  }

  /** @returns {string} */
  get file () { return path.join(this.dir, 'sessions.json') }

  /**
   * Every override on disk. A corrupt file reads as empty: one bad edit must
   * not break prompt assembly for every session at once.
   *
   * @returns {Record<string, {enabled: boolean, cardId?: string}>}
   */
  readAll () {
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      return {}
    }
    const raw = parsed !== null && typeof parsed === 'object' ? parsed.sessions : undefined
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out = {}
    for (const [id, value] of Object.entries(/** @type {Record<string, unknown>} */ (raw))) {
      if (!SESSION_ID_PATTERN.test(id)) continue
      const norm = normaliseOverride(value)
      if (norm !== undefined) out[id] = norm
    }
    return out
  }

  /** @param {string} sessionId @returns {{enabled: boolean, cardId?: string} | undefined} */
  get (sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return undefined
    return this.readAll()[sessionId]
  }

  /** Atomically replace the whole map. */
  #writeAll (sessions) {
    this.dir && fs.mkdirSync(this.dir, { recursive: true })
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(tmp, JSON.stringify({ version: SESSIONS_VERSION, sessions }, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, this.file)
  }

  /**
   * Set one session's override.
   *
   * @param {string} sessionId
   * @param {{enabled: boolean, cardId?: string | undefined}} value
   * @returns {{ok: true} | {ok: false, problem: string}}
   */
  set (sessionId, value) {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
      return { ok: false, problem: `invalid session id ${JSON.stringify(sessionId)}` }
    }
    const norm = normaliseOverride({ enabled: value?.enabled, cardId: value?.cardId })
    if (norm === undefined) return { ok: false, problem: 'enabled must be a boolean' }
    const all = this.readAll()
    all[sessionId] = norm
    this.#writeAll(all)
    return { ok: true }
  }

  /**
   * Drop one session's override, returning it to the global default.
   *
   * @param {string} sessionId
   * @returns {'removed' | 'absent' | 'invalid'}
   */
  clear (sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return 'invalid'
    const all = this.readAll()
    if (!(sessionId in all)) return 'absent'
    delete all[sessionId]
    this.#writeAll(all)
    return 'removed'
  }
}

/**
 * The resolution rule, in one place so the prompt path and any UI agree.
 *
 * A session may name its own card, or opt out entirely; otherwise it follows
 * whatever is globally active.
 *
 * @param {object | undefined} override - this session's override, if any.
 * @param {object | undefined} globalCard - the globally active card, if any.
 * @param {(id: string) => object | undefined} [getCard] - resolves a session-named card.
 * @returns {{card: object | undefined, reason: string, wanted?: string}}
 */
export function resolveCard (override, globalCard, getCard = () => undefined) {
  if (override?.enabled === false) return { card: undefined, reason: 'session-disabled' }
  if (override?.cardId !== undefined) {
    const named = getCard(override.cardId)
    if (named === undefined) {
      // The session asked for a card that no longer exists. Contributing nothing
      // is right: injecting a different persona than the one requested is worse
      // than injecting none, and the reason is surfaced for diagnosis.
      return { card: undefined, reason: 'session-card-missing', wanted: override.cardId }
    }
    return { card: named, reason: 'session-card' }
  }
  if (globalCard === undefined) return { card: undefined, reason: 'no-global-card' }
  return { card: globalCard, reason: override?.enabled === true ? 'session-global' : 'global' }
}
