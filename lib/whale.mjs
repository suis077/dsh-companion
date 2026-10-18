/**
 * dsh-persona-card — whale-widget asset bridge.
 *
 * The whale widget (dsh-whale-widget) keeps its customisations in three
 * directories under `$DSH_HOME`, each as `<id>.<ext>` files plus one JSON index:
 *
 *   whale-roles/         roles.json        { version, roles:     [{ id, name, pinnedAt, createdAt, format }] }
 *   whale-audio/         audio.json        { version, groups: [], fragments: [{ id, name, createdAt }] }
 *   whale-bubble-imgs/   bubble-imgs.json  { version, images:    [{ id, name, format, createdAt }] }
 *
 * Formats and directory names were read from the widget's own source
 * (dsh-whale-widget/lib/index.js: `readRolesIndex`, `readAudioIndex`,
 * `readBubbleImgIndex`, and the id patterns in `roleFilePath` /
 * `audioFragmentPath`).
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE: **merge, never clobber.**
 * The widget owns these files and writes them itself whenever the user edits
 * something in its menu. A bridge that rewrote an index wholesale would destroy
 * whatever the user configured there — and an index the widget cannot parse
 * silently collapses to its defaults, which looks like "all my roles vanished".
 * So every write here:
 *
 *   1. re-reads the current index,
 *   2. merges our entry in by id (only touching ids we own),
 *   3. drops entries whose file has disappeared,
 *   4. writes atomically.
 *
 * If the existing index is unreadable we DO NOT write at all: a corrupt index
 * means we cannot know what we would be destroying, and the widget would rather
 * see its own defaults than a file we guessed at.
 */
import fs from 'node:fs'
import path from 'node:path'

/** Prefix for every id this plugin owns, so the widget's own entries are never mistaken for ours. */
export const ID_PREFIX = 'dshp_'

/** The widget's own id pattern for role and audio files. */
const ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** Older entries may lack a format; the widget reads those as png. */
export function normaliseFormat (format) {
  return format === 'gif' ? 'gif' : 'png'
}

/** A card-scoped, stable asset id. */
export function assetId (cardId, kind, slug) {
  const safe = String(slug ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || kind
  return `${ID_PREFIX}${String(cardId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24)}_${safe}`.slice(0, 64)
}

/** True when an id was created by this plugin. */
export function isOurs (id) {
  return typeof id === 'string' && id.startsWith(ID_PREFIX)
}

/** Read JSON, or `undefined` when absent/unreadable/not an object. */
function readJson (file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Atomic write: tmp file then rename, so a crash cannot leave a half-written index. */
function writeJsonAtomic (file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * The three stores, described once so the merge logic is written once.
 *
 * `arrayKey` is the property holding the entry list; `fileFor` names the asset
 * file that must exist for an entry to be kept.
 */
export const STORES = {
  roles: {
    dirName: 'whale-roles',
    indexName: 'roles.json',
    arrayKey: 'roles',
    fileFor: (entry) => `${entry.id}.${normaliseFormat(entry.format) === 'gif' ? 'gif' : 'png'}`,
  },
  audio: {
    dirName: 'whale-audio',
    indexName: 'audio.json',
    arrayKey: 'fragments',
    fileFor: (entry) => `${entry.id}.wav`,
    extraArrays: ['groups'],
  },
  bubbleImgs: {
    dirName: 'whale-bubble-imgs',
    indexName: 'bubble-imgs.json',
    arrayKey: 'images',
    fileFor: (entry) => `${entry.id}.${normaliseFormat(entry.format) === 'gif' ? 'gif' : 'png'}`,
  },
}

/** Resolve one store's directory under a home. */
export function storeDir (home, kind) {
  const spec = STORES[kind]
  if (spec === undefined) throw new Error(`unknown whale store: ${kind}`)
  return path.join(home, spec.dirName)
}

/**
 * Merge entries into one store's index and write it.
 *
 * @param {object} options
 * @param {string} options.dir - the store directory.
 * @param {string} options.kind - key into {@link STORES}.
 * @param {object[]} options.add - entries to insert or update (matched by id).
 * @param {boolean} [options.dryRun] - compute the result without writing.
 * @returns {{ok: boolean, problem?: string, index?: object, added?: number, updated?: number, pruned?: number, files?: string[]}}
 */
export function mergeStore ({ dir, kind, add, dryRun = false }) {
  const spec = STORES[kind]
  if (spec === undefined) return { ok: false, problem: `unknown whale store: ${kind}` }
  if (!Array.isArray(add)) return { ok: false, problem: 'add must be an array' }

  const indexFile = path.join(dir, spec.indexName)
  const existed = fs.existsSync(indexFile)
  const current = existed ? readJson(indexFile) : { version: 1, [spec.arrayKey]: [] }

  // An index we cannot parse is an index whose contents we do not know: refuse
  // rather than overwrite someone else's data with our guess.
  if (current === undefined) {
    return { ok: false, problem: `${spec.indexName} exists but is not readable JSON — refusing to overwrite it` }
  }
  if (!Array.isArray(current[spec.arrayKey])) {
    return { ok: false, problem: `${spec.indexName} has no "${spec.arrayKey}" array — refusing to overwrite it` }
  }

  const next = { ...current, version: current.version ?? 1 }
  const list = current[spec.arrayKey].slice()

  let added = 0
  let updated = 0
  for (const entry of add) {
    if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string') continue
    if (!ASSET_ID_PATTERN.test(entry.id)) return { ok: false, problem: `invalid asset id: ${entry.id}` }
    // Only ever touch our own ids. This is the guard that makes "merge" safe:
    // without it, an id collision would rewrite a widget-owned entry.
    if (!isOurs(entry.id)) return { ok: false, problem: `refusing to write a non-plugin id: ${entry.id}` }
    const at = list.findIndex((e) => e !== null && typeof e === 'object' && e.id === entry.id)
    if (at >= 0) { list[at] = { ...list[at], ...entry }; updated += 1 } else { list.push(entry); added += 1 }
  }

  // Drop our entries whose file is gone, so the widget never lists a broken
  // item. Widget-owned entries and dangling non-plugin entries are left alone:
  // deleting those is not ours to do.
  let pruned = 0
  const kept = list.filter((e) => {
    if (e === null || typeof e !== 'object' || typeof e.id !== 'string') return true
    if (!isOurs(e.id)) return true
    const file = path.join(dir, spec.fileFor(e))
    if (fs.existsSync(file)) return true
    pruned += 1
    return false
  })

  next[spec.arrayKey] = kept
  for (const key of spec.extraArrays ?? []) {
    if (!Array.isArray(next[key])) next[key] = []
  }

  if (dryRun) return { ok: true, index: next, added, updated, pruned, files: [indexFile] }

  writeJsonAtomic(indexFile, next)
  return { ok: true, index: next, added, updated, pruned, files: [indexFile] }
}

/**
 * Copy one asset file into a store directory.
 *
 * @returns {{ok: boolean, problem?: string, file?: string, skipped?: boolean}}
 */
export function installAsset ({ dir, kind, id, sourceFile, dryRun = false }) {
  const spec = STORES[kind]
  if (spec === undefined) return { ok: false, problem: `unknown whale store: ${kind}` }
  if (!ASSET_ID_PATTERN.test(id)) return { ok: false, problem: `invalid asset id: ${id}` }
  if (!fs.existsSync(sourceFile)) return { ok: false, problem: `source file not found: ${sourceFile}` }

  const ext = path.extname(spec.fileFor({ id, format: path.extname(sourceFile).slice(1) === 'gif' ? 'gif' : 'png' })).slice(1)
  const target = path.join(dir, `${id}.${ext}`)

  // Skip an identical copy, so a re-sync is cheap and does not churn mtimes
  // (the widget watches these directories).
  try {
    if (fs.existsSync(target)) {
      const a = fs.readFileSync(sourceFile)
      const b = fs.readFileSync(target)
      if (a.length === b.length && a.equals(b)) return { ok: true, file: target, skipped: true }
    }
  } catch {
    /* fall through to the copy */
  }

  if (dryRun) return { ok: true, file: target }
  fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(sourceFile, target)
  return { ok: true, file: target }
}

/**
 * Read a store's contents (for verification and for the summary the tool prints).
 *
 * @returns {{entries: object[], ours: object[], problem?: string}}
 */
export function readStore ({ dir, kind }) {
  const spec = STORES[kind]
  if (spec === undefined) return { entries: [], ours: [], problem: `unknown whale store: ${kind}` }
  const file = path.join(dir, spec.indexName)
  if (!fs.existsSync(file)) return { entries: [], ours: [] }
  const parsed = readJson(file)
  if (parsed === undefined || !Array.isArray(parsed[spec.arrayKey])) {
    return { entries: [], ours: [], problem: `${spec.indexName} is unreadable or malformed` }
  }
  const entries = parsed[spec.arrayKey]
  return { entries, ours: entries.filter((e) => e !== null && typeof e === 'object' && isOurs(e.id)) }
}

/**
 * Which whale asset a card binding maps to.
 *
 * `kind` picks the store; `slug` keeps the generated id stable per card so a
 * re-sync updates the same entry instead of piling up new ones.
 */
const BINDINGS = {
  roleImage: { kind: 'roles', slug: 'role', name: (card) => card.name },
  bubbleImage: { kind: 'bubbleImgs', slug: 'bubble', name: (card) => card.name },
  pressSound: { kind: 'audio', slug: 'press', name: (card) => `${card.name} 按压` },
  releaseSound: { kind: 'audio', slug: 'release', name: (card) => `${card.name} 松开` },
}

/** The binding table, for callers that need to describe it. */
export const WHALE_BINDINGS = BINDINGS

/**
 * Push one card's bound assets into the whale widget's stores.
 *
 * Never removes anything the widget owns; only ids this plugin generated are
 * inserted, updated, or pruned. A card with no assets is a no-op, not an error.
 *
 * @param {object} options
 * @param {string} options.home - `$DSH_HOME`.
 * @param {object} options.card - a validated card.
 * @param {boolean} [options.dryRun]
 * @returns {{ok: boolean, problem?: string, results: object[]}}
 */
export function syncCard ({ home, card, dryRun = false }) {
  if (card === null || typeof card !== 'object') return { ok: false, problem: 'card must be an object', results: [] }
  const assets = card.assets !== null && typeof card.assets === 'object' ? card.assets : {}
  const results = []

  // Group by store so each index is read and written once, not once per asset.
  /** @type {Map<string, {kind: string, dir: string, entries: object[], files: string[]}>} */
  const byStore = new Map()

  for (const [key, binding] of Object.entries(BINDINGS)) {
    const sourceFile = assets[key]
    if (typeof sourceFile !== 'string' || sourceFile === '') continue

    const dir = storeDir(home, binding.kind)
    const id = assetId(card.id, binding.kind, binding.slug)
    const ext = path.extname(sourceFile).toLowerCase()
    const format = ext === '.gif' ? 'gif' : 'png'

    const installed = installAsset({ dir, kind: binding.kind, id, sourceFile, dryRun })
    if (!installed.ok) {
      results.push({ key, id, kind: binding.kind, ok: false, problem: installed.problem })
      continue
    }

    const group = byStore.get(binding.kind) ?? { kind: binding.kind, dir, entries: [], files: [] }
    const entry = { id, name: binding.name(card), createdAt: Date.now() }
    if (binding.kind !== 'audio') entry.format = format
    group.entries.push(entry)
    group.files.push(installed.file)
    byStore.set(binding.kind, group)
    results.push({ key, id, kind: binding.kind, ok: true, file: installed.file, skipped: installed.skipped === true })
  }

  for (const group of byStore.values()) {
    const merged = mergeStore({ dir: group.dir, kind: group.kind, add: group.entries, dryRun })
    if (!merged.ok) {
      // Surface the refusal against every asset that fed this store, so the
      // caller can tell which binding failed rather than just "something did".
      for (const r of results) {
        if (r.kind === group.kind && r.ok) { r.ok = false; r.problem = merged.problem }
      }
      continue
    }
    for (const r of results) {
      if (r.kind === group.kind && r.ok) r.merged = { added: merged.added, updated: merged.updated, pruned: merged.pruned }
    }
  }

  const failed = results.filter((r) => r.ok !== true)
  return { ok: failed.length === 0, problem: failed.length === 0 ? undefined : failed.map((f) => `${f.key}: ${f.problem}`).join('; '), results }
}
