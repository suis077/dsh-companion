/**
 * Run every offline check for dsh-persona-card.
 *
 * Usage: node tools/check-all.mjs
 *        node tools/check-all.mjs --no-live   # skip the live-prompt checks
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HERE = import.meta.dirname
const skipLive = process.argv.includes('--no-live')

// A throwaway store, so a suite that forgets to pass `storeDir` still cannot
// touch the real `$DSH_HOME/persona-cards`.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-suite-'))
const env = { ...process.env, PERSONA_TEST_DIR: sandbox }

const suites = [
  ['host section', 'check-host.mjs'],
  ['card store', 'check-cards.mjs'],
  ['session overrides', 'check-sessions.mjs'],
  ['panel routes + fence', 'check-routes.mjs'],
  ['client contract', 'check-client.mjs'],
  ['whale bridge', 'check-whale.mjs'],
  ['create + sync', 'check-create.mjs'],
  ['usage accounting', 'check-usage.mjs'],
  ['persona memory', 'check-memory.mjs'],
  ['memory actions', 'check-remember.mjs'],
  ['billing split', 'check-billing.mjs'],
  ['credit multipliers', 'check-multiplier.mjs'],
  ...(skipLive ? [] : [
    ['live ledger reconciliation', 'verify-usage.mjs'],
    ['live billing split', 'verify-billing.mjs'],
  ]),
]

let failed = 0
try {
  for (const [label, file] of suites) {
    console.log(`\n${'='.repeat(64)}\n${label}  (${file})\n${'='.repeat(64)}`)
    const r = spawnSync(process.execPath, [path.join(HERE, file)], { stdio: 'inherit', env })
    if (r.status !== 0) {
      failed += 1
      console.log(`\n>>> ${label}: FAILED (exit ${r.status})`)
    }
  }
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true })
}

console.log(`\n${'='.repeat(64)}`)
if (failed === 0) {
  console.log(`ALL ${suites.length} SUITES PASSED`)
  process.exit(0)
}
console.log(`${failed} of ${suites.length} SUITES FAILED`)
process.exit(1)
