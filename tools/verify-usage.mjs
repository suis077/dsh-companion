/**
 * Reconcile this plugin's ledger figures against the whale's OWN file.
 *
 * This reads the real `$DSH_HOME/.dshw-usage.json`, computes the summary through
 * `lib/usage.mjs`, and then re-derives the same numbers with independent raw
 * arithmetic straight off the JSON. Agreement means the plugin is a faithful
 * reader; disagreement means it is lying somewhere.
 *
 * Read-only: it never writes the ledger.
 *
 * Run: node tools/verify-usage.mjs
 */
import fs from 'node:fs'
import { readLedger, summarise, dayTotals, unitsToYuan, UNITS_PER_YUAN, ledgerFile } from '../lib/usage.mjs'

const failures = []
function check (label, ok, detail) {
  if (ok) { console.log(`  PASS  ${label}`); return }
  failures.push(label)
  console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

console.log('dsh-persona-card ledger reconciliation\n')
console.log(`ledger file: ${ledgerFile()}`)

const read = readLedger()
if (!read.ok) {
  console.log(`\nNo ledger to reconcile: ${read.problem}`)
  console.log('(This is expected on a machine where the whale widget has never run.)')
  process.exit(0)
}

const raw = read.ledger
const summary = summarise(raw, { days: 7 })
const dt = dayTotals(raw)

console.log(`currency   : ${summary.currency}`)
console.log(`today      : ${summary.todayKey}`)
console.log(`raw top-level keys: ${Object.keys(raw).join(', ')}`)

// ---- independent recomputation, straight off the JSON ----------------------
const books = raw?.accounting?.books ?? {}
const activeKey = books[raw?.accounting?.active] !== undefined ? raw.accounting.active : Object.keys(books)[0]
const book = books[activeKey] ?? {}
const rawDays = Object.values(book.days ?? {})

const rawTodayUnits = rawDays
  .filter((d) => d?.day === summary.todayKey)
  .reduce((a, d) => a + (Number.isFinite(d?.debitUnits) ? d.debitUnits : 0), 0)
const rawLifetimeUnits = rawDays.reduce((a, d) => a + (Number.isFinite(d?.debitUnits) ? d.debitUnits : 0), 0)
const rawWeekUnits = [...rawDays]
  .sort((a, b) => (String(b?.day) < String(a?.day) ? -1 : 1))
  .slice(0, 7)
  .reduce((a, d) => a + (Number.isFinite(d?.debitUnits) ? d.debitUnits : 0), 0)

console.log('\n--- reconciliation table ---')
console.log('figure        | plugin      | raw JSON    | match')
const rows = [
  ['today (CNY)', unitsToYuan(rawTodayUnits), summary.today.yuan, unitsToYuan(rawTodayUnits) === summary.today.yuan],
  ['7-day (CNY)', unitsToYuan(rawWeekUnits), summary.window.yuan, unitsToYuan(rawWeekUnits) === summary.window.yuan],
  ['lifetime (CNY)', unitsToYuan(rawLifetimeUnits), summary.lifetime.yuan, unitsToYuan(rawLifetimeUnits) === summary.lifetime.yuan],
]
for (const [label, rawv, plugv, ok] of rows) {
  console.log(`${label.padEnd(13)} | ${String(plugv).padEnd(11)} | ${String(rawv).padEnd(11)} | ${ok ? 'yes' : 'NO'}`)
}

console.log('\nchecks')
check('the active book was resolved', activeKey !== undefined, String(activeKey))
check("today's figure matches raw debitUnits", unitsToYuan(rawTodayUnits) === summary.today.yuan, `${summary.today.yuan} vs ${unitsToYuan(rawTodayUnits)}`)
check('the 7-day figure matches raw debitUnits', unitsToYuan(rawWeekUnits) === summary.window.yuan, `${summary.window.yuan} vs ${unitsToYuan(rawWeekUnits)}`)
check('the lifetime figure matches raw debitUnits', unitsToYuan(rawLifetimeUnits) === summary.lifetime.yuan, `${summary.lifetime.yuan} vs ${unitsToYuan(rawLifetimeUnits)}`)
check('the day count matches the raw book', dt.ok === true && dt.days.length === rawDays.length, `${dt.days?.length} vs ${rawDays.length}`)
check('day totals sum to the reported lifetime', dt.days.reduce((a, d) => a + d.debitUnits, 0) === summary.lifetime.units)

// ---- the two口径, reported side by side ------------------------------------
// These are DIFFERENT MEASUREMENTS and must never be merged silently. The
// accounting book counts observed balance drops; the event log counts turns and
// is pruned. On this machine they disagree, and that disagreement is real.
console.log('\n--- two sources, deliberately not merged ---')
console.log(`accounting book (headline) : ¥${summary.lifetime.yuan} all time · ¥${summary.today.yuan} today`)
console.log(`event log (per-turn detail): ¥${summary.eventLog.yuan} over ${summary.eventLog.entries} turns · ¥${summary.eventLog.todayYuan} today (${summary.eventLog.todayTurns} turns)`)
const differs = Math.abs(summary.eventLog.units - summary.lifetime.units) > 1
console.log(`the two disagree: ${differs ? 'yes — the event log is NOT reconciled against the balance' : 'no'}`)
check('both figures are exposed, neither is silently dropped', typeof summary.eventLog.yuan === 'string' && typeof summary.lifetime.yuan === 'string')
check('the headline figure is the accounting one', summary.lifetime.yuan === unitsToYuan(rawLifetimeUnits))

// ---- today's events, itemised --------------------------------------------
const todayEvents = (raw.events ?? []).filter((e) => e?.day === summary.todayKey)
console.log(`\ntoday's recorded turns (${todayEvents.length}):`)
let manualUnits = 0
for (const e of todayEvents) {
  const units = Math.round((Number.isFinite(e.cost) ? e.cost : 0) * UNITS_PER_YUAN)
  manualUnits += units
  console.log(`  ${new Date(e.ts).toLocaleTimeString()}  ¥${unitsToYuan(units)}  ${e.tokens} tokens  ${e.model}`)
}
check("today's itemised sum matches the event-log figure (not the book)", unitsToYuan(manualUnits) === summary.eventLog.todayYuan, `${unitsToYuan(manualUnits)} vs ${summary.eventLog.todayYuan}`)

if (failures.length > 0) {
  console.log(`\nRESULT: FAILED (${failures.length}) -> ${failures.join('; ')}`)
  process.exit(1)
}
console.log('\nRESULT: OK — the plugin\'s figures agree with the ledger')
