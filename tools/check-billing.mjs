/**
 * Offline checks for the billing split (credits vs money).
 *
 * The load-bearing properties:
 *   1. a credit-funded step is NEVER priced as money, and vice versa;
 *   2. an unknown provider is not guessed into either bucket;
 *   3. an unknown multiplier makes the credit total visibly INCOMPLETE rather
 *      than silently zero;
 *   4. token counting matches the whale's own convention (reasoning not
 *      double-counted), so the two plugins agree.
 *
 * Run: node tools/check-billing.mjs
 */
import { classifySource, billedTokens, creditsFor, BillingSplit, parseStepRecords, summariseSplit, CREDIT_PROVIDERS, MONEY_PROVIDERS } from '../lib/billing.mjs'

const failures = []
function check (label, ok, detail) {
  if (ok) { console.log(`  PASS  ${label}`); return }
  failures.push(label)
  console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

console.log('dsh-persona-card billing-split check\n')

// ------------------------------------------------------------ classification
console.log('classification')
check('workbuddy is credits', classifySource({ provider: 'workbuddy', model: 'x' }).kind === 'credits')
check('workbuddy-global is credits', classifySource({ provider: 'workbuddy-global' }).kind === 'credits')
check('deepseek is money', classifySource({ provider: 'deepseek' }).kind === 'money')
check('an unknown provider is its own bucket', classifySource({ provider: 'some-proxy' }).kind === 'unknown')
check('a missing source is unknown, not money', classifySource(undefined).kind === 'unknown')
check('  ...and does not throw', classifySource(null).kind === 'unknown')
check('the model name is preserved', classifySource({ provider: 'workbuddy', model: 'm1' }).model === 'm1')
check('a credit provider carries a label', typeof classifySource({ provider: 'workbuddy' }).label === 'string')
// Two money spellings: `deepseek` (config) and `deepseek-official` (what the
// desktop build actually reports). Missing the second one filed real spend under
// "unrecognised", so the panel showed ¥0.00 while the balance dropped.
check('both credit providers are declared', Object.keys(CREDIT_PROVIDERS).length === 2, JSON.stringify(Object.keys(CREDIT_PROVIDERS)))
check('both money spellings are declared', Object.keys(MONEY_PROVIDERS).length === 2, JSON.stringify(Object.keys(MONEY_PROVIDERS)))
check('deepseek-official is money, not unknown', classifySource({ provider: 'deepseek-official' }).kind === 'money', classifySource({ provider: 'deepseek-official' }).kind)

// ------------------------------------------------------------ token counting
console.log('\ntoken counting (must match the whale)')
check('sums input + cache + output', billedTokens({ inputTokens: 1, cacheReadTokens: 2, outputTokens: 3 }).total === 6)
check('reasoning is NOT added again', billedTokens({ inputTokens: 0, cacheReadTokens: 0, outputTokens: 100, reasoningTokens: 50 }).total === 100, String(billedTokens({ inputTokens: 0, cacheReadTokens: 0, outputTokens: 100, reasoningTokens: 50 }).total))
check('missing fields count as 0', billedTokens({}).total === 0)
check('undefined usage is 0, not NaN', billedTokens(undefined).total === 0)
check('non-numeric junk counts as 0', billedTokens({ inputTokens: 'x', outputTokens: null }).total === 0)

// ------------------------------------------------------------ credit formula
console.log('\ncredit formula (verified against the plugin README)')
check('1M tokens at x1 = 1 credit', creditsFor(1e6, 1) === 1)
check('25000 tokens at x0.79 ≈ 0.0198 (README says a probe reports 0.02)', Math.abs(creditsFor(25000, 0.79) - 0.01975) < 1e-9, String(creditsFor(25000, 0.79)))
check('a x0 multiplier is free (a real 0, not unknown)', creditsFor(1e6, 0) === 0)
check('an absent multiplier is UNKNOWN, not 0', creditsFor(1e6, undefined) === undefined)
check('a negative multiplier is rejected', creditsFor(1e6, -1) === undefined)
check('negative tokens are rejected', creditsFor(-5, 1) === undefined)
check('NaN multiplier is rejected', creditsFor(1e6, NaN) === undefined)

// ------------------------------------------------------------ accumulator
console.log('\naccumulator')
const s = new BillingSplit()
s.add({ source: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' }, usage: { inputTokens: 1000, cacheReadTokens: 0, outputTokens: 0 }, multiplierFor: () => 0.11 })
s.add({ source: { provider: 'deepseek', model: 'deepseek-v4.1-flash' }, usage: { inputTokens: 500, cacheReadTokens: 0, outputTokens: 0 }, moneyAmount: 0.5 })
s.add({ source: { provider: 'mystery' }, usage: { inputTokens: 7, cacheReadTokens: 0, outputTokens: 0 } })
const j = s.toJSON()

check('credits accumulate separately', j.credits.tokens === 1000 && j.credits.steps === 1, JSON.stringify(j.credits))
check('credits amount uses the multiplier', Math.abs(j.credits.amount - 0.00011) < 1e-12, String(j.credits.amount))
check('money accumulates separately', j.money.tokens === 500 && j.money.steps === 1, JSON.stringify(j.money))
check('money amount is the supplied CNY figure', j.money.amount === 0.5, String(j.money.amount))
check('an unknown provider lands in neither ledger', j.unknown.tokens === 7 && j.unknown.steps === 1, JSON.stringify(j.unknown))
check('  ...and is named', j.unknown.providers.includes('mystery'), JSON.stringify(j.unknown.providers))
check('the two totals are NOT summed together anywhere', Object.keys(j).join(',') === 'credits,money,unknown', Object.keys(j).join(','))
check('a complete credit total is flagged complete', j.credits.complete === true)

// An unknown multiplier must make the total visibly partial.
const partial = new BillingSplit()
partial.add({ source: { provider: 'workbuddy', model: 'unknown-model' }, usage: { inputTokens: 1e6, outputTokens: 0 }, multiplierFor: () => undefined })
const pj = partial.toJSON()
check('an unknown multiplier flags the total INCOMPLETE', pj.credits.complete === false)
check('  ...and does not invent an amount', pj.credits.amount === 0, String(pj.credits.amount))
check('  ...while still counting the tokens', pj.credits.tokens === 1e6, String(pj.credits.tokens))

// A genuinely free model is complete AND zero — different from unknown.
const free = new BillingSplit()
free.add({ source: { provider: 'workbuddy', model: 'hy3' }, usage: { inputTokens: 1e6 }, multiplierFor: () => 0 })
const fj = free.toJSON()
check('a x0 model reports 0 AND complete', fj.credits.amount === 0 && fj.credits.complete === true, JSON.stringify(fj.credits))

// ------------------------------------------------------------ log parsing
console.log('\nlog parsing')
const events = [
  { type: 'assistant/message', data: { turn: 1, usage: { inputTokens: 10, cacheReadTokens: 20, outputTokens: 30 }, message: { source: { kind: 'model', provider: 'workbuddy', model: 'm' } } } },
  { type: 'assistant/message', data: { turn: 1, usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 0 }, message: { source: { kind: 'model', provider: 'deepseek', model: 'd' } } } },
  { type: 'tool/call', data: { whatever: true } },
  { type: 'assistant/message', data: { turn: 2, message: { source: { provider: 'workbuddy' } } } }, // no usage
  { type: 'assistant/message', data: { turn: 2, usage: { outputTokens: 5 } } },                      // no source
]
const rows = parseStepRecords(events)
check('only assistant/message rows with usage are kept', rows.length === 3, String(rows.length))
check('a row carries the provider', rows[0].provider === 'workbuddy')
check('a row carries the classification', rows[0].kind === 'credits' && rows[1].kind === 'money')
check('a row totals tokens', rows[0].tokens === 60, String(rows[0].tokens))
check('a row with no source is classified unknown', rows[2].kind === 'unknown', JSON.stringify(rows[2]))
check('a message without usage is skipped', !rows.some((r) => r.turn === 2 && r.tokens === 0 && r.provider === ''), JSON.stringify(rows))
check('junk input does not throw', parseStepRecords(null).length === 0 && parseStepRecords([null, 5, 'x']).length === 0)

const summary = summariseSplit(parseStepRecords(events), (model) => (model === 'm' ? 0.11 : undefined))
check('the summary splits the parsed rows', summary.credits.tokens === 60 && summary.money.tokens === 1, JSON.stringify({ c: summary.credits.tokens, m: summary.money.tokens }))
// The snapshot rounds credits to 6 decimals, so compare at that precision.
check('  ...credits computed with the multiplier', Math.abs(summary.credits.amount - (60 / 1e6) * 0.11) < 1e-6, String(summary.credits.amount))
// A money step is now priced from the published table when the caller does not
// supply an amount: a bare token count does not answer "how much did I spend".
check('  ...money is priced from the published table', summary.money.amount > 0, String(summary.money.amount))
check('  ...at the idle rate for a small input (1 token)', Math.abs(summary.money.amount - 1 / 1e6 * 1) < 1e-6, String(summary.money.amount))
check('  ...the unknown step is reported', summary.unknown.tokens === 5, String(summary.unknown.tokens))

// ------------------------------------------------------------ the real bug, as a regression test
console.log('\nregression: a credit turn must never be priced as money')
// The whale would have charged this turn CNY. We must not.
const regression = new BillingSplit()
regression.add({ source: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' }, usage: { inputTokens: 50825914 }, multiplierFor: () => 0.11 })
const rj = regression.toJSON()
check('the credit turn is counted as credits', rj.credits.tokens === 50825914)
check('  ...and adds ZERO to the money ledger', rj.money.amount === 0 && rj.money.tokens === 0, JSON.stringify(rj.money))
check('  ...produces a credit figure of ~5.59', Math.abs(rj.credits.amount - 5.59085054) < 1e-6, String(rj.credits.amount))

// ------------------------------------------------------------ cross-session totals
console.log('\ncross-session totals (the panel headline)')
{
  // Two sessions, the way the plugin runs them: one process-wide accumulator
  // plus one per session. The headline must span both chats, because a per-chat
  // figure reads as 0 in every fresh chat.
  const process = new BillingSplit()
  const perSession = new Map()
  const note = (sid, provider, model, tokens, mult) => {
    const step = { source: { provider, model }, usage: { inputTokens: tokens }, multiplierFor: () => mult }
    process.add(step)
    let agg = perSession.get(sid)
    if (agg === undefined) { agg = new BillingSplit(); perSession.set(sid, agg) }
    agg.add(step)
  }

  note('chat-A', 'workbuddy', 'm', 1_000_000, 0.11) // 0.11 credits
  note('chat-A', 'workbuddy', 'm', 2_000_000, 0.11) // 0.22 credits
  note('chat-B', 'workbuddy', 'm', 3_000_000, 0.11) // 0.33 credits
  note('chat-B', 'deepseek', 'd', 1_000_000, undefined) // money

  const p = process.toJSON()
  const a = perSession.get('chat-A').toJSON()
  const b = perSession.get('chat-B').toJSON()

  check('the process total spans both chats', p.credits.steps === 3 && p.money.steps === 1, JSON.stringify({ c: p.credits.steps, m: p.money.steps }))
  check('  ...and sums their credits', Math.abs(p.credits.amount - 0.66) < 1e-6, String(p.credits.amount))
  check('each chat keeps its own share', a.credits.steps === 2 && b.credits.steps === 1, JSON.stringify({ a: a.credits.steps, b: b.credits.steps }))
  check('  ...and their shares add up to the total', Math.abs((a.credits.amount + b.credits.amount) - p.credits.amount) < 1e-6)
  check('a fresh chat still sees the running total', b.credits.steps === 1 && p.credits.steps === 3)
  // "Separate" means the money ledger holds ONLY the money step's tokens, and
  // the credit ledger only the credit steps' — not that money is always zero.
  check('credits and money stay separate at process scope too', p.money.steps === 1 && p.money.tokens === 1_000_000 && p.credits.steps === 3, JSON.stringify({ m: p.money, c: p.credits.steps }))
  check('  ...the money step is priced, not left at zero', p.money.amount > 0, String(p.money.amount))
  // A session share exceeding the process total would mean double counting.
  check('a session share never exceeds the process total', a.credits.tokens <= p.credits.tokens)
}

if (failures.length > 0) {
  console.log(`\nRESULT: FAILED (${failures.length}) -> ${failures.join('; ')}`)
  process.exit(1)
}
console.log('\nRESULT: OK — all checks passed')
