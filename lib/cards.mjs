/**
 * dsh-companion — card store.
 *
 * Plain node: no DSH imports, so this module is unit-testable on its own.
 * The Host plugin is the only production caller.
 *
 * Layout under the store directory:
 *   <dir>/index.json        { version, activeId }
 *   <dir>/<cardId>.json     one card per file
 *
 * Writes are atomic (tmp file + rename) so a crash mid-write cannot leave a
 * half-written card that then fails to parse at prompt-assembly time.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** Card ids are used as file names, so they must stay boring. */
export const CARD_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** Bumped when the on-disk shape changes in a way readers must know about. */
export const STORE_VERSION = 1

/**
 * Resolve `$DSH_HOME` the way the rest of the harness does.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function dshHome (env = process.env) {
  return env.DSH_HOME && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
}

/**
 * Resolve the default store directory: `$DSH_HOME/persona-cards`, falling back
 * to `~/.dsh/persona-cards` the way the rest of the harness does.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function defaultStoreDir (env = process.env) {
  return path.join(dshHome(env), 'persona-cards')
}

/**
 * Validated optional asset bindings on a card.
 *
 * Each entry is an ABSOLUTE path on this host. Validated when the card is SAVED
 * rather than when a sync runs: a card pointing at a file that does not exist
 * should be rejected at write time, not silently skipped at sync time.
 */
export const ASSET_KEYS = ['roleImage', 'pressSound', 'releaseSound', 'bubbleImage']

/**
 * Normalise a card's `assets` field.
 *
 * Existence is checked HERE, at save time, not at sync time. The reason is that
 * a saved card is durable state the user will see again later: letting one in
 * with a path that already points at nothing turns a momentary typo into a
 * permanent broken binding that only surfaces as a failed sync much later, with
 * the cause several steps away from the symptom.
 *
 * @param {unknown} assets
 * @returns {{ok: true, assets: object} | {ok: false, problem: string}}
 */
export function normaliseAssets (assets) {
  if (assets === undefined) return { ok: true, assets: {} }
  if (assets === null || typeof assets !== 'object' || Array.isArray(assets)) {
    return { ok: false, problem: 'card.assets must be an object when present' }
  }
  const out = {}
  for (const [key, value] of Object.entries(assets)) {
    if (!ASSET_KEYS.includes(key)) {
      return { ok: false, problem: `unknown asset key "${key}" (allowed: ${ASSET_KEYS.join(', ')})` }
    }
    if (value === undefined || value === null || value === '') continue
    if (typeof value !== 'string') return { ok: false, problem: `card.assets.${key} must be a string path` }
    if (!path.isAbsolute(value)) return { ok: false, problem: `card.assets.${key} must be an absolute path (got ${JSON.stringify(value)})` }
    if (!fs.existsSync(value)) return { ok: false, problem: `card.assets.${key} points at a file that does not exist: ${value}` }
    out[key] = value
  }
  return { ok: true, assets: out }
}

/**
 * Validate a card object.
 *
 * @param {unknown} card
 * @returns {{ok: true, card: object} | {ok: false, problem: string}}
 */
export function validateCard (card) {
  if (card === null || typeof card !== 'object' || Array.isArray(card)) {
    return { ok: false, problem: 'card must be an object' }
  }
  const c = /** @type {Record<string, unknown>} */ (card)
  if (typeof c.id !== 'string' || !CARD_ID_PATTERN.test(c.id)) {
    return { ok: false, problem: `card.id must match ${String(CARD_ID_PATTERN)} (got ${JSON.stringify(c.id)})` }
  }
  if (typeof c.name !== 'string' || c.name.trim() === '') {
    return { ok: false, problem: 'card.name must be a non-empty string' }
  }
  if (typeof c.systemPrompt !== 'string' || c.systemPrompt.trim() === '') {
    return { ok: false, problem: 'card.systemPrompt must be a non-empty string' }
  }
  for (const key of ['trigger', 'note']) {
    if (c[key] !== undefined && typeof c[key] !== 'string') {
      return { ok: false, problem: `card.${key} must be a string when present` }
    }
  }
  const assets = normaliseAssets(c.assets)
  if (!assets.ok) return { ok: false, problem: assets.problem }
  return { ok: true, card: { ...c, assets: assets.assets } }
}

/** Atomically replace a file's contents. */
function writeFileAtomic (file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

/** Read JSON, returning a fallback instead of throwing on absent/corrupt files. */
function readJson (file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

export class CardStore {
  /**
   * @param {string} dir - store directory (created on demand).
   */
  constructor (dir) {
    if (typeof dir !== 'string' || dir.trim() === '') throw new TypeError('CardStore requires a directory')
    this.dir = dir
  }

  /** @returns {string} */
  get indexFile () { return path.join(this.dir, 'index.json') }

  /** @param {string} id */
  cardFile (id) { return path.join(this.dir, `${id}.json`) }

  ensureDir () {
    fs.mkdirSync(this.dir, { recursive: true })
  }

  /**
   * All cards on disk, sorted by name. Unreadable or invalid files are skipped
   * rather than thrown: one bad card must not break prompt assembly.
   *
   * @returns {object[]}
   */
  list () {
    let names
    try {
      names = fs.readdirSync(this.dir)
    } catch {
      return []
    }
    const cards = []
    for (const name of names) {
      if (!name.endsWith('.json') || name === 'index.json' || name.includes('.tmp-')) continue
      const parsed = readJson(path.join(this.dir, name), undefined)
      if (parsed === undefined) continue
      const v = validateCard(parsed)
      if (v.ok) cards.push(v.card)
    }
    return cards.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  }

  /** @param {string} id @returns {object | undefined} */
  get (id) {
    if (typeof id !== 'string' || !CARD_ID_PATTERN.test(id)) return undefined
    const parsed = readJson(this.cardFile(id), undefined)
    if (parsed === undefined) return undefined
    const v = validateCard(parsed)
    return v.ok ? v.card : undefined
  }

  /**
   * Insert or replace one card. Never touches other cards.
   *
   * @param {object} card
   * @returns {{ok: true, card: object, replaced: boolean} | {ok: false, problem: string}}
   */
  upsert (card) {
    const v = validateCard(card)
    if (!v.ok) return { ok: false, problem: v.problem }
    this.ensureDir()
    const replaced = fs.existsSync(this.cardFile(v.card.id))
    writeFileAtomic(this.cardFile(v.card.id), JSON.stringify(v.card, null, 2) + '\n')
    return { ok: true, card: v.card, replaced }
  }

  /**
   * Create a card only when that id is absent, never overwriting an existing
   * one. Useful for seeding a default without clobbering a user's edits.
   *
   * @param {string} id
   * @param {object} card
   * @returns {'created' | 'kept' | 'invalid'}
   */
  seedIfAbsent (id, card) {
    const v = validateCard(card)
    if (!v.ok) return 'invalid'
    if (fs.existsSync(this.cardFile(id))) return 'kept'
    const r = this.upsert(card)
    return r.ok ? 'created' : 'invalid'
  }

  /** @returns {string | undefined} */
  getActiveId () {
    const idx = readJson(this.indexFile, undefined)
    const id = idx !== null && typeof idx === 'object' ? /** @type {any} */ (idx).activeId : undefined
    return typeof id === 'string' && CARD_ID_PATTERN.test(id) ? id : undefined
  }

  /**
   * Point the store at a card. Passing `undefined` clears the selection.
   *
   * @param {string | undefined} id
   * @returns {{ok: true} | {ok: false, problem: string}}
   */
  setActiveId (id) {
    if (id !== undefined && (typeof id !== 'string' || !CARD_ID_PATTERN.test(id))) {
      return { ok: false, problem: `invalid card id ${JSON.stringify(id)}` }
    }
    if (id !== undefined && !fs.existsSync(this.cardFile(id))) {
      return { ok: false, problem: `no such card: ${id}` }
    }
    this.ensureDir()
    writeFileAtomic(this.indexFile, JSON.stringify({ version: STORE_VERSION, activeId: id ?? null }, null, 2) + '\n')
    return { ok: true }
  }

  /**
   * The card whose text should be injected, or `undefined` when nothing is
   * selected or the selection no longer resolves.
   *
   * @returns {object | undefined}
   */
  activeCard () {
    const id = this.getActiveId()
    return id === undefined ? undefined : this.get(id)
  }
}
