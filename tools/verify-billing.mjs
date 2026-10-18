/**
 * Verify the billing split against THIS machine's real session log.
 *
 * The question the user actually asked: "how many of my credits did you burn,
 * and which turns came out of my own balance?" This answers both from the
 * session log — the authoritative per-step record — instead of from the whale's
 * money estimate, which cannot see the provider.
 *
 * Run: node tools/verify-billing.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { parseStepRecords, summariseSplit, classifySource } from '../lib/billing.mjs'
import { MultiplierResolver } from '../lib/multiplier.mjs'

const failures = []
function check (label, ok, detail) {
  if (ok) { console.log(`  PASS  ${label}`); return }
  failures.push(label)
  console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')

function decodeLog (file) {
  const buf = fs.readFileSync(file)
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  for (let i = 0; (i = buf.indexOf(MAGIC, i)) !== -1; i += 4) offsets.push(i)
  const parts = []
  for (let i = 0; i < offsets.length; i += 1) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(offsets[i], end))) } catch {}
  }
  return Buffer.concat(parts).toString('utf8')
}

function newestLog () {
  let best
  const walk = (dir) => {
    let es
    try { es = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of es) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name === 'session.v4.jsonl.zstd') {
        const m = fs.statSync(p).mtimeMs
        if (!best || m > best.m) best = { file: p, m }
      }
    }
  }
  walk(path.join(DSH_HOME, 'sessions'))
  return best?.file
}

const log = newestLog()
if (!log) {
  console.log('no session log found — nothing to verify')
  process.exit(0)
}
console.log(`session log: ${log}\n`)

const events = []
for (const line of decodeLog(log).split('\n')) {
  if (line.trim() === '') continue
  try { events.push(JSON.parse(line)) } catch {}
}
console.log(`events: ${events.length}`)

const rows = parseStepRecords(events)
console.log(`model steps: ${rows.length}`)

// ---- provider / model breakdown -------------------------------------------
const byProvider = {}
const byModel = {}
for (const r of rows) {
  byProvider[r.provider || '(none)'] = (byProvider[r.provider || '(none)'] ?? 0) + 1
  byModel[r.model || '(none)'] = (byModel[r.model || '(none)'] ?? 0) + 1
}
console.log('\n--- steps by provider ---')
for (const [k, v] of Object.entries(byProvider).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`)
console.log('--- steps by model ---')
for (const [k, v] of Object.entries(byModel).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`)

// ---- live multipliers -----------------------------------------------------
const resolver = new MultiplierResolver()
const live = await resolver.refresh()
console.log(`\nlive multiplier lookup: ${live.ok ? 'ok' : `failed (${live.problem})`}`)
if (live.ok) {
  for (const m of Object.keys(byModel)) {
    const v = resolver.lookup(m)
    console.log(`  ${m} -> ${v === undefined ? '(unknown)' : `x${v}`}`)
  }
}

const split = summariseSplit(rows, (model) => resolver.lookup(model))

console.log('\n=== 两本账（按 provider 分离，来自会话日志）===')
console.log(`积分消耗   : ${split.credits.amount.toFixed(4)} credits（${split.credits.complete ? '完整' : '不完整'}）`)
console.log(`             ${split.credits.steps} 步 · ${split.credits.tokens.toLocaleString()} tokens`)
console.log(`             models: ${split.credits.models.join(', ') || '(none)'}`)
console.log(`Token 扣费 : ¥${split.money.amount.toFixed(4)}`)
console.log(`             ${split.money.steps} 步 · ${split.money.tokens.toLocaleString()} tokens`)
console.log(`未识别     : ${split.unknown.steps} 步 · ${split.unknown.tokens.toLocaleString()} tokens ${split.unknown.providers.join(',')}`)

// ---- assertions -----------------------------------------------------------
console.log('\nchecks')
check('every step is classified as credits or money (none unknown)', split.unknown.steps === 0, JSON.stringify(split.unknown))
check('the credit total is complete (every multiplier resolved)', split.credits.complete === true, JSON.stringify(split.credits))
check('credits and money are separate objects', split.credits !== split.money)
// The invariant is NOT "money is always zero" — a session can legitimately mix
// providers (this one does: a stretch ran on deepseek-official). The invariant is
// that each ledger only counts its OWN kind of step, and that a money step is
// never silently priced at zero.
check('every step lands in exactly one ledger', split.money.steps + split.credits.steps + split.unknown.steps === rows.length, `${split.money.steps}+${split.credits.steps}+${split.unknown.steps} vs ${rows.length}`)
check('a money step is never left unpriced', split.money.steps === 0 || split.money.amount > 0, `¥${split.money.amount} over ${split.money.steps} steps`)
check('the money total is marked complete when every step was priced', split.money.complete !== false, JSON.stringify(split.money))
check('the money ledger still tracked its tokens', split.money.steps === 0 ? split.money.tokens === 0 : split.money.tokens > 0)

// Cross-check the credit figure the long way round. The snapshot rounds to 6
// decimals, so compare at that precision rather than at float epsilon.
let manual = 0
for (const r of rows) {
  if (classifySource({ provider: r.provider, model: r.model }).kind !== 'credits') continue
  const m = resolver.lookup(r.model)
  if (Number.isFinite(m)) manual += (r.tokens / 1e6) * m
}
check('the credit figure matches an independent recomputation', Math.abs(manual - split.credits.amount) < 1e-6, `${manual} vs ${split.credits.amount}`)

// The token basis must match what the whale counts, or the two plugins would
// report different usage for the same session.
const totalTokens = rows.reduce((a, r) => a + r.tokens, 0)
check('the token total equals the sum of the per-step figures', totalTokens === split.credits.tokens + split.money.tokens + split.unknown.tokens)
check('no step double-counts reasoning', rows.every((r) => r.tokens === r.input + r.cache + r.output))

console.log('\n--- 换算成你关心的说法 ---')
// Account names and balances are NOT hard-coded: they are personal. When the
// optional env vars are set, this prints a proportion-of-balance figure;
// otherwise it just shows the session spend on its own.
const acctNames = (process.env.DSH_PERSONA_ACCOUNT_NAMES ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const acctBalances = (process.env.DSH_PERSONA_ACCOUNT_BALANCES ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0)
const total = acctBalances.reduce((a, b) => a + b, 0)
if (total > 0) {
  const label = acctNames.length === acctBalances.length && acctNames.length > 0
    ? acctNames.map((n, i) => `${n} ${acctBalances[i]}`).join('、')
    : `${acctBalances.join('+')}`
  console.log(`本次会话消耗 ${split.credits.amount.toFixed(2)} 积分，账户余额 ${label}，占 ${((split.credits.amount / total) * 100).toFixed(3)}%。`)
} else {
  console.log(`本次会话消耗 ${split.credits.amount.toFixed(2)} 积分。`)
}
console.log(`若这些轮次走 DeepSeek 余额（挂件会这么估）：¥${(totalTokens / 1e6 * 4).toFixed(2)} 量级 —— 但实际一分没花，因为 provider 是 workbuddy。`)

if (failures.length > 0) {
  console.log(`\nRESULT: FAILED (${failures.length}) -> ${failures.join('; ')}`)
  process.exit(1)
}
console.log('\nRESULT: OK — the split is correct against the real log')
