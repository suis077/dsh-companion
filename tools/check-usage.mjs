/**
 * Offline checks for step 6: the ledger reader and card attribution.
 *
 * Two things matter here and both are tested:
 *   1. the money arithmetic agrees with the ledger's own integers, and
 *   2. attribution does not overstate itself — it must leave pre-observation
 *      spend UNATTRIBUTED rather than spreading it across cards.
 *
 * Run: node tools/check-usage.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { summarise, dayTotals, events, sumEvents, unitsToYuan, today, UNITS_PER_YUAN, readLedger, ledgerFile, readTimeline, recordActiveCard, attributeEvents, timelineFile } from '../lib/usage.mjs'

const failures = []
function check (label, ok, detail) {
  if (ok) { console.log(`  PASS  ${label}`); return }
  failures.push(label)
  console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-usage-'))
console.log(`dsh-persona-card usage check\nworkdir: ${tmp}\n`)

/** A ledger shaped exactly like the real one (fields verified against the live file). */
function ledgerFixture (dayList, eventList) {
  const days = {}
  for (const d of dayList) days[d.day] = d
  return {
    date: '2026-10-16',
    lastBalance: 5.89,
    todayUsage: 0,
    accounting: {
      version: 1,
      active: 'acct-CNY',
      books: {
        'acct-CNY': { currency: 'CNY', days, lastAt: 1 },
      },
    },
    events: eventList,
  }
}

try {
  // ------------------------------------------------ money arithmetic
  console.log('money')
  check('1 yuan is 1e8 units', UNITS_PER_YUAN === 100000000)
  check('unitsToYuan formats 2 decimals', unitsToYuan(11000000) === '0.11', unitsToYuan(11000000))
  check('unitsToYuan handles 0', unitsToYuan(0) === '0.00')
  check('unitsToYuan handles non-finite', unitsToYuan(NaN) === '0.00')
  check('unitsToYuan avoids float drift', unitsToYuan(3 * 3333333) === '0.10', unitsToYuan(3 * 3333333))

  // Integer summing must not drift the way float addition would.
  const drift = Array.from({ length: 1000 }, () => ({ cost: 0.01, tokens: 1 }))
  const driftSum = sumEvents(drift)
  check('1000 x 0.01 sums to exactly 10.00', unitsToYuan(driftSum.units) === '10.00', unitsToYuan(driftSum.units))
  check('sumEvents also totals tokens', driftSum.tokens === 1000, String(driftSum.tokens))

  // ------------------------------------------------ dayTotals
  console.log('\ndayTotals')
  const ledger = ledgerFixture(
    [
      { day: '2026-10-15', firstAt: 1, lastAt: 2, openingUnits: 0, lastUnits: 589000000, debitUnits: 11000000, creditUnits: 600000000, revision: 0, correction: null },
      { day: '2026-10-16', firstAt: 3, lastAt: 4, openingUnits: 589000000, lastUnits: 589000000, debitUnits: 25000000, creditUnits: 0, revision: 0, correction: null },
    ],
    [
      { ts: 1792119887109, day: '2026-10-16', model: 'deepseek-v4.1-flash', cost: 0.03193496, tokens: 22701 },
      { ts: 1792119888109, day: '2026-10-16', model: 'deepseek-v4.1-flash', cost: 0.05, tokens: 100 },
      { ts: 100, day: '2026-10-15', model: 'deepseek-v4.1-flash', cost: 0.11, tokens: 500 },
    ],
  )

  const dt = dayTotals(ledger)
  check('dayTotals reads the active book', dt.ok === true && dt.bookKey === 'acct-CNY', JSON.stringify(dt))
  check('  ...reports the currency', dt.currency === 'CNY')
  check('  ...returns days newest-first', dt.days[0].day === '2026-10-16', JSON.stringify(dt.days.map((d) => d.day)))
  check('  ...keeps the ledger\'s integer units intact', dt.days[1].debitUnits === 11000000, String(dt.days[1].debitUnits))

  // A ledger whose book is missing must degrade, not throw.
  check('a missing accounting block degrades', dayTotals({}).ok === false)
  check('an empty book list degrades', dayTotals({ accounting: { books: {} } }).ok === false)
  check('a book with no days degrades', dayTotals({ accounting: { books: { a: { currency: 'CNY' } } } }).ok === false)

  // ------------------------------------------------ summarise
  console.log('\nsummarise')
  const sum = summarise(ledger, { days: 7, now: new Date('2026-10-16T12:00:00') })
  check('today is the supplied date', sum.todayKey === '2026-10-16', sum.todayKey)
  // Headline numbers come from the accounting book, matching the widget's own UI.
  check('today uses the accounting book', sum.today.yuan === unitsToYuan(25000000), sum.today.yuan)
  check('the 7-day window comes from the accounting book', sum.window.days.length === 2, String(sum.window.days.length))
  check('  ...and its total is the sum of debitUnits', sum.window.units === 11000000 + 25000000, String(sum.window.units))
  check('  ...formatted to 2 decimals', sum.window.yuan === '0.36', sum.window.yuan)
  check('lifetime uses the accounting book', sum.lifetime.units === 11000000 + 25000000, String(sum.lifetime.units))
  // The event-log口径 is exposed separately and must NOT be merged into the above.
  check('the event log is reported separately', sum.eventLog.entries === 3, String(sum.eventLog.entries))
  check('  ...with its own today figure', sum.eventLog.todayTurns === 2, String(sum.eventLog.todayTurns))
  check('  ...and its own total, which may differ from the book',
    sum.eventLog.units === Math.round(0.03193496 * UNITS_PER_YUAN) + Math.round(0.05 * UNITS_PER_YUAN) + Math.round(0.11 * UNITS_PER_YUAN),
    String(sum.eventLog.units))
  check('the two口径 are genuinely independent fields', typeof sum.today.yuan === 'string' && typeof sum.eventLog.todayYuan === 'string')
  check('a bad ledger still yields a summary object', summarise({}).dayDataAvailable === false)
  check('a bad ledger reports zero for headline figures (no invented data)', summarise({}).today.yuan === '0.00' && summarise({}).lifetime.yuan === '0.00')

  // ------------------------------------------------ timeline
  console.log('\ntimeline')
  const storeDir = path.join(tmp, 'cards')
  check('reading an absent timeline yields []', readTimeline(storeDir).length === 0)
  check('recording the first entry works', recordActiveCard(storeDir, { at: 1000, cardId: 'a', sessionId: 's1' }) === 'recorded')
  check('an identical repeat is not recorded', recordActiveCard(storeDir, { at: 1001, cardId: 'a', sessionId: 's1' }) === 'unchanged')
  check('a switch IS recorded', recordActiveCard(storeDir, { at: 1002, cardId: 'b', sessionId: 's1' }) === 'recorded')
  check('a different session is tracked independently', recordActiveCard(storeDir, { at: 1003, cardId: 'a', sessionId: 's2' }) === 'recorded')
  check('  ...and its repeat is not', recordActiveCard(storeDir, { at: 1004, cardId: 'a', sessionId: 's2' }) === 'unchanged')
  const tl = readTimeline(storeDir)
  check('the timeline holds 3 entries', tl.length === 3, String(tl.length))
  check('  ...sorted by time', tl[0].at === 1000 && tl[2].at === 1003, JSON.stringify(tl.map((e) => e.at)))
  check('a malformed line is skipped', (() => {
    fs.appendFileSync(timelineFile(storeDir), '{ not json\n')
    return readTimeline(storeDir).length === 3
  })())
  check('recordActiveCard never throws on junk input', recordActiveCard(storeDir, null) === 'skipped')

  // ------------------------------------------------ attribution
  console.log('\nattribution (must NOT overstate itself)')
  const timeline = [
    { at: 100, cardId: '', sessionId: '' },
    { at: 500, cardId: 'a', sessionId: 's1' },
    { at: 1500, cardId: 'b', sessionId: 's1' },
  ]
  const att = attributeEvents([
    { ts: 50, cost: 0.10, tokens: 10, day: 'd' },    // before any observation -> unattributed
    { ts: 600, cost: 0.20, tokens: 20, day: 'd' },   // card a
    { ts: 1400, cost: 0.30, tokens: 30, day: 'd' },  // still card a
    { ts: 1600, cost: 0.40, tokens: 40, day: 'd' },  // card b
  ], timeline)

  check('events attributed to card a', att.cards.find((c) => c.id === 'a')?.yuan === '0.50', JSON.stringify(att.cards))
  check('events attributed to card b', att.cards.find((c) => c.id === 'b')?.yuan === '0.40', JSON.stringify(att.cards))
  check('the pre-observation event is NOT attributed', att.unattributed.yuan === '0.10', JSON.stringify(att.unattributed))
  check('attributed + unattributed equals the input total', unitsToYuan(att.attributed.units + att.unattributed.units) === '1.00', unitsToYuan(att.attributed.units + att.unattributed.units))
  check('coverage is reported honestly', att.coverage === 0.9, String(att.coverage))
  check('cards are sorted by spend', att.cards[0].id === 'a', JSON.stringify(att.cards.map((c) => c.id)))
  check('turn counts are per card', att.cards.find((c) => c.id === 'a')?.turns === 2, String(att.cards.find((c) => c.id === 'a')?.turns))

  // A period where injection was OFF must be unattributed, not charged to a card.
  const off = attributeEvents([{ ts: 200, cost: 0.5, tokens: 5, day: 'd' }], [{ at: 100, cardId: '', sessionId: 's' }])
  check('spend while injection was off is unattributed', off.attributed.units === 0 && off.unattributed.yuan === '0.50', JSON.stringify(off))

  // No timeline at all -> nothing attributed.
  const none = attributeEvents([{ ts: 200, cost: 0.5, tokens: 5, day: 'd' }], [])
  check('with no observations, nothing is attributed', none.attributed.units === 0 && none.unattributed.units === Math.round(0.5 * UNITS_PER_YUAN), JSON.stringify(none))
  check('  ...coverage is 1 of an all-unattributed set (no phantom gains)', none.coverage === 0, String(none.coverage))

  // An empty event list must not divide by zero.
  const empty = attributeEvents([], timeline)
  check('an empty event list yields coverage 1 (nothing to attribute)', empty.coverage === 1, String(empty.coverage))
  check('  ...no crash on a non-array timeline', attributeEvents([], null).cards.length === 0)

  // ------------------------------------------------ ledger reading
  console.log('\nledger reading')
  const home = path.join(tmp, 'home')
  fs.mkdirSync(home, { recursive: true })
  check('a missing ledger reports a problem', readLedger({ DSH_HOME: home }).ok === false)
  check('  ...and the message names the path', readLedger({ DSH_HOME: home }).problem.includes('.dshw-usage.json'))
  fs.writeFileSync(ledgerFile({ DSH_HOME: home }), JSON.stringify(ledger))
  check('a real ledger reads', readLedger({ DSH_HOME: home }).ok === true)
  fs.writeFileSync(ledgerFile({ DSH_HOME: home }), '{ half written')
  check('a half-written ledger reports a problem, does not throw', readLedger({ DSH_HOME: home }).ok === false)
  fs.writeFileSync(ledgerFile({ DSH_HOME: home }), '[1,2,3]')
  check('an array ledger is rejected', readLedger({ DSH_HOME: home }).ok === false)

  // ------------------------------------------------ today()
  console.log('\ntoday()')
  check('formats as YYYY-MM-DD', today(new Date('2026-01-05T09:00:00')) === '2026-01-05', today(new Date('2026-01-05T09:00:00')))
  check('zero-pads month and day', today(new Date('2026-12-31T09:00:00')) === '2026-12-31', today(new Date('2026-12-31T09:00:00')))
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.log(`\nRESULT: FAILED (${failures.length}) -> ${failures.join('; ')}`)
  process.exit(1)
}
console.log('\nRESULT: OK — all checks passed')
