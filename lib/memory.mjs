/**
 * dsh-persona-card — persona memory.
 *
 * WHY THIS EXISTS, and what it deliberately is not:
 *
 * A card without memory resets every session: the same persona greets the same
 * person as a stranger each time. This module keeps a small, durable record of
 * what happened BETWEEN the task talk — the jokes, the moods, the things the
 * person cared about — so a later session starts already knowing them.
 *
 * It is NOT a transcript. Original wording is never stored; each entry is a
 * short summary plus how it landed. That keeps the file small, keeps it from
 * becoming a surveillance log of everything typed, and forces the writer to
 * decide what actually mattered.
 *
 * Storage: `<storeDir>/memories/<cardId>.json`
 *
 *   {
 *     version: 1,
 *     affinity: 0..100,          // a character-consistency device, NOT a metric of a real relationship
 *     mood: "一句话心情",
 *     traits: ["嘴硬心软", ...],  //性格关键词，逐渐累积
 *     chapters: [{ at, kind, summary, feeling }],
 *     lastSeen: "ISO ts",
 *     updatedAt: "ISO ts"
 *   }
 *
 * Writes are atomic (tmp + rename), and an unreadable file degrades to a fresh
 * memory rather than throwing: a corrupt memory must never break prompt
 * assembly, which is the one path that runs on every single turn.
 */
import fs from 'node:fs'
import path from 'node:path'
import { CARD_ID_PATTERN, dshHome } from './cards.mjs'

/** Bumped when the on-disk shape changes in a way readers must know about. */
export const MEMORY_VERSION = 1

/**
 * How many off-directory snapshots to keep per card.
 *
 * The `.bak` next to the file protects against a bad WRITE. This protects
 * against the file and its folder disappearing together, which is the case the
 * in-place backup cannot help with at all. Snapshots are timestamped so several
 * generations coexist; the oldest are pruned once the cap is reached.
 */
export const MAX_OFF_DIR_SNAPSHOTS = 30

/**
 * Fields that change on every write, so they must not make a snapshot look new.
 *
 * Without this, `updatedAt` alone makes every write produce a fresh snapshot and
 * the cap fills with thirty copies of the same content.
 */
const VOLATILE_FIELDS = ['updatedAt']

/**
 * How many chapters are kept.
 *
 * Beyond this the oldest are folded into a single summary entry rather than
 * dropped outright — otherwise a long-running persona would forget its earliest
 * and most defining moments first, which is backwards.
 */
export const MAX_CHAPTERS = 200

/** How many chapters are rendered into the prompt. */
export const RECALL_CHAPTERS = 12

/** Chapter kinds. Unknown kinds are preserved on read but never written. */
export const CHAPTER_KINDS = ['chat', 'emotion', 'trait', 'milestone']

/** Affinity bounds. Values outside are clamped, never rejected: a slightly wrong
 *  number is better than a failed write when the model is mid-conversation. */
export const AFFINITY_MIN = 0
export const AFFINITY_MAX = 100

/** Summary length cap — long enough to carry meaning, short enough to stay a summary. */
export const SUMMARY_MAX = 200
export const FEELING_MAX = 120
/** Cap on how many traits are kept, so the character does not become a word salad. */
export const MAX_TRAITS = 24

/**
 * The directory holding every card's memory.
 *
 * @param {string} storeDir - the persona-card store directory.
 */
export function memoriesDir (storeDir) {
  return path.join(storeDir, 'memories')
}

/**
 * One card's memory file.
 *
 * @param {string} storeDir
 * @param {string} cardId
 * @returns {string | undefined} undefined when the id is not safe as a filename.
 */
export function memoryFile (storeDir, cardId) {
  if (typeof cardId !== 'string' || !CARD_ID_PATTERN.test(cardId)) return undefined
  return path.join(memoriesDir(storeDir), `${cardId}.json`)
}

/** A blank memory. */
export function emptyMemory () {
  return {
    version: MEMORY_VERSION,
    affinity: 0,
    mood: '',
    traits: [],
    chapters: [],
    lastSeen: '',
    updatedAt: '',
  }
}

/** Clamp a number into [min, max]; non-finite becomes `fallback`. */
function clamp (value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/** Trim to at most `max` characters, without splitting a surrogate pair. */
export function clip (text, max) {
  const s = typeof text === 'string' ? text.trim() : ''
  if (s.length <= max) return s
  // Avoid cutting an emoji in half: step back one if we landed mid-pair.
  let end = max
  const code = s.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return s.slice(0, end).trimEnd() + '…'
}

/**
 * Validate and normalise one chapter.
 *
 * @returns {object | undefined} undefined when the entry is unusable.
 */
export function normaliseChapter (entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined
  const summary = typeof entry.summary === 'string' ? clip(entry.summary, SUMMARY_MAX) : ''
  if (summary === '') return undefined
  const at = typeof entry.at === 'string' && entry.at !== '' ? entry.at : new Date().toISOString()
  const kind = CHAPTER_KINDS.includes(entry.kind) ? entry.kind : 'chat'
  const feeling = typeof entry.feeling === 'string' ? clip(entry.feeling, FEELING_MAX) : ''
  return feeling === '' ? { at, kind, summary } : { at, kind, summary, feeling }
}

/**
 * Coerce whatever is on disk into a usable memory.
 *
 * Everything questionable is repaired rather than rejected: this object feeds a
 * prompt, and the prompt must still render for a user with a hand-edited file.
 *
 * @param {unknown} raw
 * @returns {object} a normalised memory (never throws).
 */
export function normaliseMemory (raw) {
  const base = emptyMemory()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return base

  const m = /** @type {Record<string, unknown>} */ (raw)
  base.affinity = Math.round(clamp(Number(m.affinity), AFFINITY_MIN, AFFINITY_MAX, 0))
  base.mood = typeof m.mood === 'string' ? clip(m.mood, FEELING_MAX) : ''
  base.lastSeen = typeof m.lastSeen === 'string' ? m.lastSeen : ''
  base.updatedAt = typeof m.updatedAt === 'string' ? m.updatedAt : ''

  if (Array.isArray(m.traits)) {
    const seen = new Set()
    for (const t of m.traits) {
      if (typeof t !== 'string') continue
      const v = clip(t, 40)
      if (v === '' || seen.has(v)) continue
      seen.add(v)
      base.traits.push(v)
      if (base.traits.length >= MAX_TRAITS) break
    }
  }

  if (Array.isArray(m.chapters)) {
    for (const c of m.chapters) {
      const n = normaliseChapter(c)
      if (n !== undefined) base.chapters.push(n)
    }
  }
  return base
}

/**
 * Fold the oldest chapters into one summary entry.
 *
 * Folding (not dropping) is deliberate: the first conversations are usually the
 * ones that defined the persona, so they are the last thing that should be lost.
 * The folded entry keeps the span so the model can still say "我们最早聊到…".
 *
 * @param {object[]} chapters
 * @param {number} max
 * @returns {{chapters: object[], folded: number}}
 */
export function foldOverflow (chapters, max = MAX_CHAPTERS) {
  if (!Array.isArray(chapters) || chapters.length <= max) {
    return { chapters: Array.isArray(chapters) ? chapters.slice() : [], folded: 0 }
  }
  // Fold a batch at a time so this does not run on every single append.
  const keep = Math.max(1, Math.floor(max / 2))
  const dropCount = chapters.length - keep
  const dropped = chapters.slice(0, dropCount)
  const kept = chapters.slice(dropCount)

  const first = dropped[0]
  const last = dropped[dropped.length - 1]
  const span = first !== undefined && last !== undefined
    ? `${String(first.at).slice(0, 10)} ~ ${String(last.at).slice(0, 10)}`
    : ''

  const foldedEntry = normaliseChapter({
    at: first?.at ?? new Date().toISOString(),
    kind: 'milestone',
    summary: clip(
      `（早期回忆合并 ${dropped.length} 条，${span}）` +
        dropped.slice(0, 5).map((c) => c.summary).join('；'),
      SUMMARY_MAX,
    ),
  })

  const out = foldedEntry === undefined ? kept : [foldedEntry, ...kept]
  return { chapters: out, folded: dropped.length }
}

export class MemoryStore {
  /**
   * @param {string} storeDir - the persona-card store directory.
   */
  constructor (storeDir) {
    if (typeof storeDir !== 'string' || storeDir.trim() === '') throw new TypeError('MemoryStore requires a store directory')
    this.storeDir = storeDir
  }

  /** Every memory file's card id. @returns {string[]} */
  listIds () {
    let names
    try {
      names = fs.readdirSync(memoriesDir(this.storeDir))
    } catch {
      return []
    }
    return names
      .filter((n) => n.endsWith('.json') && !n.includes('.tmp-'))
      .map((n) => n.slice(0, -5))
      .filter((id) => CARD_ID_PATTERN.test(id))
  }

  /**
   * Read one card's memory. A missing or unreadable file yields a blank memory:
   * the caller cannot distinguish "never talked" from "file corrupted", and for
   * prompt rendering those are the same situation.
   *
   * @param {string} cardId
   * @returns {object}
   */
  read (cardId) {
    const file = memoryFile(this.storeDir, cardId)
    if (file === undefined) return emptyMemory()
    try {
      return normaliseMemory(JSON.parse(fs.readFileSync(file, 'utf8')))
    } catch {
      return emptyMemory()
    }
  }

  /**
   * Whether a card has any memory worth rendering.
   *
   * @param {string} cardId
   * @returns {boolean}
   */
  has (cardId) {
    const m = this.read(cardId)
    return m.chapters.length > 0 || m.mood !== '' || m.traits.length > 0 || m.affinity > 0
  }

  /** The backup file next to a memory file. */
  backupFile (cardId) {
    const file = memoryFile(this.storeDir, cardId)
    return file === undefined ? undefined : `${file}.bak`
  }

  /**
   * Report a card's memory on disk WITHOUT silently swallowing a loss.
   *
   * `read()` deliberately degrades to a blank memory, because prompt assembly
   * must never fail. But that makes a deleted or corrupted file indistinguishable
   * from "never talked" — the memory simply vanishes and nobody notices. This
   * method exists so a caller that CAN surface the difference (the panel, the
   * recall action) is able to.
   *
   * @param {string} cardId
   * @returns {{state: 'ok'|'missing'|'corrupt', memory: object, hasBackup: boolean, backupChapters: number}}
   */
  inspect (cardId) {
    const file = memoryFile(this.storeDir, cardId)
    const blank = emptyMemory()
    if (file === undefined) return { state: 'missing', memory: blank, hasBackup: false, backupChapters: 0 }

    let state = 'missing'
    let memory = blank
    if (fs.existsSync(file)) {
      try {
        memory = normaliseMemory(JSON.parse(fs.readFileSync(file, 'utf8')))
        state = 'ok'
      } catch {
        state = 'corrupt'
        memory = blank
      }
    }

    let backupChapters = 0
    const bak = this.backupFile(cardId)
    if (bak !== undefined && fs.existsSync(bak)) {
      try {
        backupChapters = normaliseMemory(JSON.parse(fs.readFileSync(bak, 'utf8'))).chapters.length
      } catch {
        backupChapters = 0
      }
    }
    return { state, memory, hasBackup: backupChapters > 0, backupChapters }
  }

  /**
   * Write one card's memory atomically, keeping the previous version as `.bak`.
   *
   * Two protections, and they guard different failures:
   *
   *   - the temp-file-plus-rename makes a crash mid-write unable to leave a
   *     half-written file;
   *   - the `.bak` copy makes an OVERWRITE recoverable. Without it, a bug that
   *     wrote a blank memory would destroy the history permanently, because the
   *     atomic rename is exactly what makes the old content unreachable.
   *
   * The backup is only refreshed when the current file is readable, so a corrupt
   * file never overwrites a good backup with garbage.
   *
   * @param {string} cardId
   * @param {object} memory
   * @returns {{ok: true, memory: object} | {ok: false, problem: string}}
   */
  write (cardId, memory) {
    const file = memoryFile(this.storeDir, cardId)
    if (file === undefined) return { ok: false, problem: `invalid card id: ${JSON.stringify(cardId)}` }
    const normalised = normaliseMemory(memory)
    const { chapters } = foldOverflow(normalised.chapters)
    normalised.chapters = chapters
    normalised.version = MEMORY_VERSION
    normalised.updatedAt = new Date().toISOString()
    try {
      fs.mkdirSync(memoriesDir(this.storeDir), { recursive: true })
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
      const text = JSON.stringify(normalised, null, 2) + '\n'
      fs.writeFileSync(tmp, text, 'utf8')
      // Back up the CURRENT file before the rename replaces it — but only if it
      // parses, so a corrupted file cannot clobber a good backup.
      this.#backupCurrent(cardId, file)
      fs.renameSync(tmp, file)
      return { ok: true, memory: normalised }
    } catch (err) {
      return { ok: false, problem: `写入失败：${String(err?.message ?? err)}` }
    }
  }

  /** Copy the current file to `.bak` when it is readable; best-effort. */
  #backupCurrent (cardId, file) {
    try {
      if (!fs.existsSync(file)) return
      const raw = fs.readFileSync(file, 'utf8')
      JSON.parse(raw) // only a parseable file is worth keeping
      const bak = this.backupFile(cardId)
      if (bak === undefined) return
      fs.writeFileSync(bak, raw, 'utf8')
    } catch {
      /* a broken current file must not stop the write or poison the backup */
    }
  }

  /**
   * Restore a card's memory from its `.bak`.
   *
   * @param {string} cardId
   * @returns {{ok: true, memory: object} | {ok: false, problem: string}}
   */
  restore (cardId) {
    const bak = this.backupFile(cardId)
    if (bak === undefined) return { ok: false, problem: `invalid card id: ${JSON.stringify(cardId)}` }
    if (!fs.existsSync(bak)) return { ok: false, problem: '没有备份文件可恢复' }
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(bak, 'utf8'))
    } catch (err) {
      return { ok: false, problem: `备份文件也坏了：${String(err?.message ?? err)}` }
    }
    const file = memoryFile(this.storeDir, cardId)
    try {
      fs.writeFileSync(file, JSON.stringify(normaliseMemory(parsed), null, 2) + '\n', 'utf8')
    } catch (err) {
      return { ok: false, problem: `恢复失败：${String(err?.message ?? err)}` }
    }
    return { ok: true, memory: this.read(cardId) }
  }

  /**
   * Append chapters and/or adjust the scalar fields.
   *
   * One method for both so a caller cannot accidentally write a stale copy: every
   * mutation re-reads, merges, and writes atomically.
   *
   * @param {string} cardId
   * @param {object} patch
   * @param {object[]} [patch.chapters] - entries to append.
   * @param {number} [patch.affinityDelta] - added to the current affinity, then clamped.
   * @param {number} [patch.affinity] - absolute value, overrides the delta.
   * @param {string} [patch.mood]
   * @param {string[]} [patch.traits] - appended, de-duplicated.
   * @param {string} [patch.lastSeen]
   * @returns {{ok: true, memory: object, appended: number} | {ok: false, problem: string}}
   */
  update (cardId, patch = {}) {
    const current = this.read(cardId)
    const next = { ...current, chapters: current.chapters.slice(), traits: current.traits.slice() }

    if (Array.isArray(patch.chapters)) {
      for (const c of patch.chapters) {
        const n = normaliseChapter(c)
        if (n !== undefined) next.chapters.push(n)
      }
    }
    if (Number.isFinite(patch.affinity)) {
      next.affinity = patch.affinity
    } else if (Number.isFinite(patch.affinityDelta)) {
      next.affinity = current.affinity + patch.affinityDelta
    }
    if (typeof patch.mood === 'string') next.mood = patch.mood
    if (Array.isArray(patch.traits)) {
      for (const t of patch.traits) {
        if (typeof t === 'string' && t.trim() !== '' && !next.traits.includes(t.trim())) {
          next.traits.push(t.trim())
        }
      }
    }
    if (typeof patch.lastSeen === 'string' && patch.lastSeen !== '') next.lastSeen = patch.lastSeen

    const written = this.write(cardId, next)
    if (!written.ok) return written
    return { ok: true, memory: written.memory, appended: Array.isArray(patch.chapters) ? patch.chapters.length : 0 }
  }

  /**
   * Write a memory AND push its snapshot to the off-directory backup in the same
   * step.
   *
   * This is the "backup on change" path the plugin prefers over a timer: it fires
   * at the exact moment a memory actually changes, so it does not depend on the
   * harness staying open, on a 6-hour interval elapsing, or on anything else
   * being remembered. A memory that changed is a memory that got backed up.
   *
   * `destDir` is optional: when omitted, only the in-place write happens and the
   * caller is responsible for backing up later (e.g. the CLI doctor).
   *
   * @param {string} cardId
   * @param {object} patch - same shape as {@link update}.
   * @param {string} [destDir]
   * @returns {Promise<{ok: boolean, problem?: string, memory?: object, appended?: number, backedUp?: boolean}>}
   */
  async updateAndBackup (cardId, patch, destDir) {
    const result = this.update(cardId, patch)
    if (!result.ok) return result
    if (typeof destDir !== 'string' || destDir.trim() === '') {
      return { ...result, backedUp: false }
    }
    const b = this.backupTo(destDir, { cardId })
    if (!b.ok) {
      // A failed backup must not make the caller think the MEMORY write failed;
      // the memory is safely written, only the off-dir copy did not happen.
      return { ...result, backedUp: false, backupProblem: b.problem }
    }
    return { ...result, backedUp: b.copied.includes(cardId) }
  }

  /**
   * Copy memories to a directory OUTSIDE the store, keeping timestamped snapshots.
   *
   * This is the only protection that survives the store directory itself going
   * away — a deleted folder, a formatted drive, a bad `rm -rf`. The `.bak` beside
   * each file is useless in exactly those cases.
   *
   * A snapshot is skipped when its content (ignoring `updatedAt`) matches the
   * newest one already there, so a quiet week does not burn the whole cap on
   * identical copies. Pruning keeps the newest MAX_OFF_DIR_SNAPSHOTS per card.
   *
   * @param {string} destDir
   * @param {{cardId?: string, keep?: number, dryRun?: boolean}} [options]
   * @returns {{ok: boolean, problem?: string, copied: string[], skipped: string[], pruned: number}}
   */
  backupTo (destDir, options = {}) {
    if (typeof destDir !== 'string' || destDir.trim() === '') {
      return { ok: false, problem: 'backupTo 需要一个目标目录', copied: [], skipped: [], pruned: 0 }
    }
    const keep = Number.isFinite(options.keep) && options.keep > 0 ? options.keep : MAX_OFF_DIR_SNAPSHOTS
    const ids = typeof options.cardId === 'string' && options.cardId !== ''
      ? [options.cardId]
      : this.listIds()

    const copied = []
    const skipped = []
    let pruned = 0

    for (const id of ids) {
      const src = memoryFile(this.storeDir, id)
      if (src === undefined || !fs.existsSync(src)) continue
      let text
      let parsed
      try {
        text = fs.readFileSync(src, 'utf8')
        parsed = JSON.parse(text)
      } catch {
        // A corrupt file is not worth a snapshot; the in-place `.bak` covers it.
        skipped.push(id)
        continue
      }

      // Compare against the newest existing snapshot, ignoring volatile fields.
      const existing = this.#snapshotsFor(destDir, id)
      const newest = existing[0]
      if (newest !== undefined) {
        try {
          const prev = JSON.parse(fs.readFileSync(newest.file, 'utf8'))
          if (sameContent(prev, parsed)) {
            skipped.push(id)
            if (!options.dryRun) pruned += this.#prune(destDir, id, keep)
            continue
          }
        } catch {
          /* an unreadable snapshot is not a reason to skip backing up */
        }
      }

      if (!options.dryRun) {
        try {
          fs.mkdirSync(destDir, { recursive: true })
          // Millisecond precision: two backups inside the same second (a fast
          // test, or two cards saved together) would otherwise collide and the
          // second would silently overwrite the first, losing a generation.
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          let target = path.join(destDir, `${id}.${stamp}.json`)
          let n = 1
          while (fs.existsSync(target)) {
            target = path.join(destDir, `${id}.${stamp}-${n}.json`)
            n += 1
          }
          fs.writeFileSync(target, text, 'utf8')
        } catch (err) {
          return { ok: false, problem: String(err?.message ?? err), copied, skipped, pruned }
        }
      }
      copied.push(id)
      if (!options.dryRun) pruned += this.#prune(destDir, id, keep)
    }

    return { ok: true, copied, skipped, pruned }
  }

  /**
   * Snapshots for one card in the backup dir, newest first.
   *
   * @returns {Array<{file: string, mtimeMs: number}>}
   */
  #snapshotsFor (destDir, cardId) {
    let names
    try {
      names = fs.readdirSync(destDir)
    } catch {
      return []
    }
    const prefix = `${cardId}.`
    const out = []
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith('.json')) continue
      const file = path.join(destDir, name)
      try {
        out.push({ file, mtimeMs: fs.statSync(file).mtimeMs })
      } catch {
        /* vanished between readdir and stat */
      }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  /** Drop snapshots beyond `keep` for one card. @returns how many were removed. */
  #prune (destDir, cardId, keep) {
    const list = this.#snapshotsFor(destDir, cardId)
    let removed = 0
    for (const entry of list.slice(keep)) {
      try {
        fs.rmSync(entry.file)
        removed += 1
      } catch {
        /* a locked file simply stays */
      }
    }
    return removed
  }
}

/**
 * Whether two memories hold the same content, ignoring volatile fields.
 *
 * Used to decide whether a snapshot is worth taking: without it, `updatedAt`
 * alone would make every write look like new data.
 */
export function sameContent (a, b) {
  const strip = (value) => {
    const m = normaliseMemory(value)
    for (const f of VOLATILE_FIELDS) delete m[f]
    return JSON.stringify(m)
  }
  try {
    return strip(a) === strip(b)
  } catch {
    return false
  }
}

/**
 * Render a memory into prompt text.
 *
 * Returns '' when there is nothing to say, so a fresh install contributes
 * nothing at all to the prompt — the caller can append the result
 * unconditionally without leaving a stray heading.
 *
 * The wording is deliberately plain: it is instructions-as-context, not
 * roleplay markup, so the model reads it as fact about the person it is talking
 * to rather than as a script to perform.
 *
 * @param {object} memory
 * @param {{chapters?: number}} [options]
 * @returns {string}
 */
export function renderMemory (memory, options = {}) {
  const m = normaliseMemory(memory)
  const take = Number.isFinite(options.chapters) ? options.chapters : RECALL_CHAPTERS

  const hasAnything = m.chapters.length > 0 || m.mood !== '' || m.traits.length > 0 || m.affinity > 0
  if (!hasAnything) return ''

  const lines = ['', '## 与人相处的记忆', '（以下是之前对话里积累下来的，不是本次会话发生的。据此保持角色连贯，不要凭空编造细节。）']

  if (m.affinity > 0) {
    // Explicitly framed as an internal gauge so the model does not treat the
    // number as permission or as a claim about the relationship.
    lines.push(`- 好感度（角色内部刻度，不是对真实关系的度量）：${m.affinity}/100`)
  }
  if (m.mood !== '') lines.push(`- 最近的心情：${m.mood}`)
  if (m.traits.length > 0) lines.push(`- 已经长出来的性格：${m.traits.join('、')}`)

  if (m.chapters.length > 0) {
    const recent = m.chapters.slice(-take)
    lines.push('', '### 记得的事（从旧到新）')
    for (const c of recent) {
      const day = String(c.at).slice(0, 10)
      const feeling = c.feeling !== undefined ? `｜当时感觉：${c.feeling}` : ''
      lines.push(`- ${day}【${c.kind}】${c.summary}${feeling}`)
    }
    if (m.chapters.length > recent.length) {
      lines.push(`- （更早还有 ${m.chapters.length - recent.length} 条）`)
    }
  }

  return lines.join('\n')
}
