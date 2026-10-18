/**
 * dsh-persona-card — usage accounting reader.
 *
 * Reads the whale widget's ledger (`$DSH_HOME/.dshw-usage.json`) and answers
 * "which persona card spent how much". The widget owns that file and writes it
 * continuously, so this module is READ-ONLY by design: a plugin that wrote it
 * would race the widget's own writes.
 *
 * Money is stored as integer "units" of 1e-8 yuan (the widget's fixed-point
 * convention), so every sum here is done in integers and only converted for
 * display. Floating-point accumulation would drift over hundreds of turns.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** The widget's fixed-point scale: 1 yuan = 1e8 units. */
export const UNITS_PER_YUAN = 100000000

/** Format integer units as yuan, keeping the widget's 2-decimal display. */
export function unitsToYuan (units) {
  if (!Number.isFinite(units)) return '0.00'
  return (units / UNITS_PER_YUAN).toFixed(2)
}

/** Today's local date as `YYYY-MM-DD`. */
export function today (now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** `$DSH_HOME` the way the rest of the harness resolves it. */
export function dshHome (env = process.env) {
  return env.DSH_HOME && env.DSH_HOME.trim() !== '' ? env.DSH_HOME : path.join(os.homedir(), '.dsh')
}

/** The ledger file the whale widget owns. */
export function ledgerFile (env = process.env) {
  return path.join(dshHome(env), '.dshw-usage.json')
}

/**
 * Read the ledger.
 *
 * Deliberately tolerant: a missing or half-written file must degrade to "no
 * data", never throw during a tool call. The widget may be mid-write when we
 * read, which is also why nothing here retries or locks.
 *
 * @returns {{ok: true, ledger: object} | {ok: false, problem: string}}
 */
export function readLedger (env = process.env) {
  const file = ledgerFile(env)
  if (!fs.existsSync(file)) {
    return { ok: false, problem: `找不到记账文件：${file}（鲸鱼挂件还没记过账？）` }
  }
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    return { ok: false, problem: `记账文件读不出来（可能正在写入）：${String(err?.message ?? err)}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, problem: '记账文件结构不是对象。' }
  }
  return { ok: true, ledger: parsed }
}

/**
 * Per-model day totals from the ledger's `accounting` book.
 *
 * The widget keys its books by `<accountId>-<CURRENCY>`; we take the active one
 * when it is present, else the first. This is the only place in the ledger that
 * carries a per-day, per-amount breakdown, so it is what "today's spend" and
 * "recent days" are built from.
 *
 * @returns {{ok: true, currency: string, days: Array<{day: string, debitUnits: number}>} | {ok: false, problem: string}}
 */
export function dayTotals (ledger) {
  const accounting = ledger?.accounting
  const books = accounting?.books
  if (books === null || typeof books !== 'object') {
    return { ok: false, problem: '记账文件里没有 accounting.books。' }
  }
  const activeKey = typeof accounting.active === 'string' && books[accounting.active] !== undefined
    ? accounting.active
    : Object.keys(books)[0]
  if (activeKey === undefined) return { ok: false, problem: '记账文件里没有可用的账本。' }
  const book = books[activeKey]
  const currency = typeof book?.currency === 'string' ? book.currency : 'CNY'
  const rawDays = book?.days
  if (rawDays === null || typeof rawDays !== 'object') {
    return { ok: false, problem: '账本里没有逐日数据。' }
  }
  const days = Object.values(rawDays)
    .filter((d) => d !== null && typeof d === 'object' && typeof d.day === 'string')
    .map((d) => ({
      day: d.day,
      debitUnits: Number.isFinite(d.debitUnits) ? d.debitUnits : 0,
      creditUnits: Number.isFinite(d.creditUnits) ? d.creditUnits : 0,
      lastUnits: Number.isFinite(d.lastUnits) ? d.lastUnits : 0,
    }))
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
  return { ok: true, currency, days, bookKey: activeKey }
}

/**
 * The ledger's recent per-turn events.
 *
 * Each event carries `cost` (yuan, a float — the widget's own display value) and
 * `tokens`. We expose them as-is and let callers sum in units.
 *
 * NOTE: these events carry NO card attribution. The ledger records what the
 * model cost, not which persona was injected — the widget has no idea this
 * plugin exists. So this function reports totals, and the caller must be honest
 * that per-card attribution is an ESTIMATE, not a measurement.
 *
 * @returns {Array<{ts: number, day: string, model: string, cost: number, tokens: number}>}
 */
export function events (ledger) {
  return Array.isArray(ledger?.events)
    ? ledger.events.filter((e) => e !== null && typeof e === 'object')
    : []
}

/** Sum a list of events' costs, in integer units. */
export function sumEvents (list) {
  let units = 0
  let tokens = 0
  for (const e of list) {
    units += Math.round((Number.isFinite(e.cost) ? e.cost : 0) * UNITS_PER_YUAN)
    tokens += Number.isFinite(e.tokens) ? e.tokens : 0
  }
  return { units, tokens }
}

/**
 * A whole-ledger summary.
 *
 * TWO DIFFERENT SOURCES, and they do NOT agree — this is the single most
 * important thing to understand about this file:
 *
 *   - the accounting book's `debitUnits` per day, which is the whale's own
 *     authoritative figure: it accumulates only observed balance DROPS, so a
 *     top-up or gift credit does not erase recorded spend;
 *   - the `events` list, one entry per turn, which is pruned over time and which
 *     the whale does NOT reconcile against the balance.
 *
 * Measured on this machine they genuinely differ (the event log showed ¥1.70 for
 * a day whose accounting debit was ¥0.00). So this function reports the
 * ACCOUNTING figures as the headline numbers — that is the口径 the whale's own
 * UI shows, and the one a user comparing against the widget will expect — and
 * exposes the event-log total separately, clearly labelled.
 *
 * @param {object} ledger
 * @param {{days?: number, now?: Date}} [options]
 */
export function summarise (ledger, options = {}) {
  const window = Number.isFinite(options.days) ? options.days : 7
  const now = options.now instanceof Date ? options.now : new Date()
  const todayKey = today(now)

  const dayResult = dayTotals(ledger)
  const all = events(ledger)
  const allSum = sumEvents(all)

  // Headline figures: the accounting book.
  const dayWindow = dayResult.ok
    ? dayResult.days.slice(0, window).map((d) => ({ ...d, yuan: unitsToYuan(d.debitUnits) }))
    : []
  const windowUnits = dayWindow.reduce((acc, d) => acc + d.debitUnits, 0)
  const lifetimeUnits = dayResult.ok
    ? dayResult.days.reduce((acc, d) => acc + d.debitUnits, 0)
    : 0
  const todayBook = dayResult.ok ? dayResult.days.find((d) => d.day === todayKey) : undefined
  const todayUnits = todayBook === undefined ? 0 : todayBook.debitUnits

  // Itemised view: the event log, which breaks today down per turn.
  const todayEvents = all.filter((e) => e.day === todayKey)
  const todaySum = sumEvents(todayEvents)

  return {
    currency: dayResult.ok ? dayResult.currency : 'CNY',
    todayKey,
    // Accounting口径 — what the whale's own UI would show.
    today: { units: todayUnits, yuan: unitsToYuan(todayUnits), turns: todayEvents.length, tokens: todaySum.tokens },
    window: { days: dayWindow, units: windowUnits, yuan: unitsToYuan(windowUnits) },
    lifetime: { units: lifetimeUnits, yuan: unitsToYuan(lifetimeUnits) },
    // Event-log口径 — per-turn detail, prunable, and not reconciled with the balance.
    eventLog: {
      units: allSum.units,
      yuan: unitsToYuan(allSum.units),
      tokens: allSum.tokens,
      entries: all.length,
      todayUnits: todaySum.units,
      todayYuan: unitsToYuan(todaySum.units),
      todayTurns: todayEvents.length,
      todayTokens: todaySum.tokens,
    },
    dayDataAvailable: dayResult.ok,
    dayProblem: dayResult.ok ? undefined : dayResult.problem,
  }
}

/**
 * Split a total across cards on the assumption that each card is charged for the
 * turns taken while it was the active persona.
 *
 * This is intentionally a small, clearly-labelled ESTIMATE helper: a precise
 * per-card figure would require recording the active card on every turn, which
 * the widget's ledger does not do. Rather than invent precision, we divide the
 * observed total evenly and say so.
 *
 * @param {number} units - the total to divide.
 * @param {string[]} cardIds - the cards to attribute it to.
 */
export function estimatePerCard (units, cardIds) {
  const ids = Array.isArray(cardIds) ? cardIds.filter((id) => typeof id === 'string' && id !== '') : []
  if (ids.length === 0) return []
  const each = Math.floor(units / ids.length)
  const remainder = units - each * ids.length
  return ids.map((id, i) => ({
    id,
    units: each + (i === 0 ? remainder : 0),
    yuan: unitsToYuan(each + (i === 0 ? remainder : 0)),
    estimated: true,
  }))
}

// ---------------------------------------------------------------------------
// Active-card timeline
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS: the whale's ledger records `{ts, day, model, cost, tokens}`
// per turn and carries NO card attribution — verified by inspecting a real
// ledger (no `cardId`, `persona`, or `sessionId` field anywhere). So "which card
// spent this" is not recoverable from the ledger alone, and any plugin claiming
// a precise per-card number would be making it up.
//
// What IS recoverable: the card that was in effect at each moment. This plugin
// resolves that on every prompt assembly, so it can record a change timeline and
// then attribute each ledger event to the card in effect at that timestamp.
// That is real attribution for the window the plugin observed, and the
// remainder is reported as unattributed rather than spread over cards.

/** Timeline file name inside the card store directory. */
export const TIMELINE_NAME = 'usage-timeline.ndjson'

/** Timeline file path. */
export function timelineFile (storeDir) {
  return path.join(storeDir, TIMELINE_NAME)
}

/**
 * Append one timeline entry, but only when it differs from the last one.
 *
 * Called from the prompt-assembly path, so it must be cheap and must never
 * throw: a failure to record attribution must not break the prompt.
 *
 * @returns {'recorded' | 'unchanged' | 'skipped'}
 */
export function recordActiveCard (storeDir, entry) {
  try {
    if (storeDir === undefined || entry === null || typeof entry !== 'object') return 'skipped'
    const cardId = typeof entry.cardId === 'string' ? entry.cardId : ''
    const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId : ''
    const at = Number.isFinite(entry.at) ? entry.at : Date.now()

    const existing = readTimeline(storeDir)
    const last = existing.at(-1)
    // Compare against the last entry for the SAME session: two sessions can hold
    // different cards at once, and each switch is what matters for attribution.
    const lastForSession = [...existing].reverse().find((e) => e.sessionId === sessionId)
    if (lastForSession !== undefined && lastForSession.cardId === cardId) return 'unchanged'

    fs.mkdirSync(storeDir, { recursive: true })
    fs.appendFileSync(timelineFile(storeDir), JSON.stringify({ at, cardId, sessionId }) + '\n', 'utf8')
    return 'recorded'
  } catch {
    return 'skipped'
  }
}

/**
 * Read the timeline. A corrupt line is skipped, not fatal.
 *
 * @returns {Array<{at: number, cardId: string, sessionId: string}>}
 */
export function readTimeline (storeDir) {
  try {
    const text = fs.readFileSync(timelineFile(storeDir), 'utf8')
    return text
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => { try { return JSON.parse(l) } catch { return undefined } })
      .filter((e) => e !== null && typeof e === 'object' && Number.isFinite(e.at))
      .map((e) => ({
        at: e.at,
        cardId: typeof e.cardId === 'string' ? e.cardId : '',
        sessionId: typeof e.sessionId === 'string' ? e.sessionId : '',
      }))
      .sort((a, b) => a.at - b.at)
  } catch {
    return []
  }
}

/**
 * Attribute ledger events to cards using the timeline.
 *
 * An event is charged to the last card in effect at or before its timestamp. It
 * is left UNATTRIBUTED when:
 *   - it predates the first timeline entry (the plugin was not running yet), or
 *   - the card in effect was "none" (the user had persona injection off).
 *
 * Nothing is guessed or spread evenly. The caller sees exactly how much was
 * observed and how much was not.
 *
 * @param {Array<{ts: number, cost: number, tokens: number, day: string}>} list
 * @param {Array<{at: number, cardId: string}>} timeline
 */
export function attributeEvents (list, timeline) {
  const events = Array.isArray(list) ? list : []
  const line = Array.isArray(timeline) ? timeline : []

  const perCard = new Map()
  let attributed = 0
  let unattributed = 0
  let unattributedTokens = 0
  let attributedTokens = 0

  for (const e of events) {
    const units = Math.round((Number.isFinite(e.cost) ? e.cost : 0) * UNITS_PER_YUAN)
    const tokens = Number.isFinite(e.tokens) ? e.tokens : 0

    // Last entry at or before this event's timestamp.
    let active
    for (const entry of line) {
      if (entry.at <= e.ts) active = entry
      else break
    }

    if (active === undefined || active.cardId === '') {
      unattributed += units
      unattributedTokens += tokens
      continue
    }
    const cur = perCard.get(active.cardId) ?? { units: 0, tokens: 0, turns: 0 }
    cur.units += units
    cur.tokens += tokens
    cur.turns += 1
    perCard.set(active.cardId, cur)
    attributed += units
    attributedTokens += tokens
  }

  const cards = [...perCard.entries()]
    .map(([id, v]) => ({ id, units: v.units, yuan: unitsToYuan(v.units), tokens: v.tokens, turns: v.turns }))
    .sort((a, b) => b.units - a.units)

  return {
    cards,
    attributed: { units: attributed, yuan: unitsToYuan(attributed), tokens: attributedTokens },
    unattributed: { units: unattributed, yuan: unitsToYuan(unattributed), tokens: unattributedTokens },
    observedFrom: line.length === 0 ? undefined : line[0].at,
    coverage: attributed + unattributed === 0 ? 1 : attributed / (attributed + unattributed),
  }
}
