/**
 * Offline checks for dsh-persona-card step 2: the card store and the Host
 * plugin's rendering.
 *
 * Runs against a throwaway store under the OS temp dir — it never reads or
 * writes the real `$DSH_HOME/persona-cards`.
 *
 * Run: node tools/check-cards.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CardStore, validateCard, defaultStoreDir, CARD_ID_PATTERN } from '../lib/cards.mjs'
import { apply } from '../index.js'

const failures = []
function check (label, ok, detail) {
  if (ok) { console.log(`  PASS  ${label}`); return }
  failures.push(label)
  console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-check-'))
console.log(`dsh-persona-card card-store check\nworkdir: ${tmp}\n`)

try {
  // ---------- validation ----------
  console.log('validation')
  check('rejects a non-object card', validateCard('nope').ok === false)
  check('rejects a bad id', validateCard({ id: 'Bad Id!', name: 'x', systemPrompt: 'y' }).ok === false)
  check('rejects an empty name', validateCard({ id: 'a', name: '  ', systemPrompt: 'y' }).ok === false)
  check('rejects an empty systemPrompt', validateCard({ id: 'a', name: 'x', systemPrompt: '' }).ok === false)
  check('accepts a well-formed card', validateCard({ id: 'a-b_c.d', name: 'x', systemPrompt: 'y' }).ok === true)
  check('id pattern rejects path traversal', CARD_ID_PATTERN.test('../evil') === false)

  // ---------- upsert / get / list ----------
  console.log('\nstore basics')
  const store = new CardStore(path.join(tmp, 'store'))
  const r1 = store.upsert({ id: 'alpha', name: '甲', systemPrompt: '你是甲。' })
  check('upsert creates a card', r1.ok === true && r1.replaced === false, JSON.stringify(r1))
  check('get reads it back', store.get('alpha')?.name === '甲')
  const r2 = store.upsert({ id: 'alpha', name: '甲改', systemPrompt: '你是甲改。' })
  check('upsert reports replacement', r2.ok === true && r2.replaced === true, JSON.stringify(r2))
  check('replacement wins', store.get('alpha')?.name === '甲改')

  const files = fs.readdirSync(path.join(tmp, 'store'))
  check('no leftover .tmp files after atomic write', !files.some((f) => f.includes('.tmp-')), files.join(','))
  check('card file is valid JSON', (() => { try { JSON.parse(fs.readFileSync(path.join(tmp, 'store', 'alpha.json'), 'utf8')); return true } catch { return false } })())

  store.upsert({ id: 'beta', name: '乙', systemPrompt: '你是乙。' })
  check('list returns both, name-sorted', store.list().map((c) => c.id).join(',') === 'alpha,beta', store.list().map((c) => c.id).join(','))

  // one corrupt card must not break listing or assembly
  fs.writeFileSync(path.join(tmp, 'store', 'broken.json'), '{ this is not json')
  check('a corrupt card is skipped, not thrown', store.list().length === 2, String(store.list().length))
  const incomplete = path.join(tmp, 'store', 'incomplete.json')
  fs.writeFileSync(incomplete, JSON.stringify({ id: 'incomplete', name: 'x' }))
  check('an invalid card is skipped', store.list().length === 2, String(store.list().length))

  // ---------- active selection ----------
  console.log('\nactive selection')
  check('no active card initially', store.activeCard() === undefined)
  check('setActiveId rejects an unknown card', store.setActiveId('ghost').ok === false)
  check('setActiveId accepts a real card', store.setActiveId('beta').ok === true)
  check('activeCard follows the selection', store.activeCard()?.id === 'beta')
  check('setActiveId(undefined) clears it', store.setActiveId(undefined).ok === true && store.activeCard() === undefined)
  store.setActiveId('alpha')

  // ---------- seed semantics ----------
  console.log('\nseed')
  const seedStore = new CardStore(path.join(tmp, 'seeded'))
  const seed = { id: 'testcard', name: '测试角色', systemPrompt: '种子正文' }
  check('seed creates when absent', seedStore.seedIfAbsent('testcard', seed) === 'created')
  check('seed keeps an existing card', seedStore.seedIfAbsent('testcard', { ...seed, systemPrompt: '不该覆盖' }) === 'kept')
  check('user edit survived the second seed', seedStore.get('testcard')?.systemPrompt === '种子正文')
  check('seed rejects an invalid card', seedStore.seedIfAbsent('x', { id: 'x' }) === 'invalid')

  // ---------- the real Host plugin, against a temp store ----------
  console.log('\nhost plugin (temp store)')
  const hostStoreDir = path.join(tmp, 'host')
  const sections = []
  const promptService = { section: (s) => { sections.push(s); return () => {} } }
  const ctx = {
    logger: { warn: () => {} },
    inject: (deps, cb) => cb({
      get: (n) => (n === 'systemPrompt' ? promptService : undefined),
      effect: (fn) => { fn(); return {} },
    }),
  }
  apply(ctx, { storeDir: hostStoreDir })
  // Two sections since the memory feature: the card and its rules.
  const cardSection = sections.find((s) => s.name === 'persona-card')
  check('the card section registered', cardSection !== undefined, sections.map((s) => s.name).join(','))
  check('text is a function', typeof cardSection?.text === 'function')

  // The plugin no longer ships a seed card — the user creates their own. A fresh
  // store must therefore start EMPTY, and a card the user adds via the tool must
  // render through the same section.
  const seededStore = new CardStore(hostStoreDir)
  check('a fresh store starts with no cards (no shipped seed)', seededStore.list().length === 0, JSON.stringify(seededStore.list()))

  // Simulate the user creating a card by hand (as the tool does).
  seededStore.upsert({ id: 'mine', name: '我的角色', systemPrompt: '你是我的角色。', trigger: '切回普通模式' })
  check('renders EMPTY while no card is active', cardSection.text() === '', JSON.stringify(cardSection.text().slice(0, 40)))
  seededStore.setActiveId('mine')
  const body = cardSection.text()
  check('renders a user-created card name once active', body.includes('## 人设卡：我的角色'))
  check('renders the user prompt verbatim', body.includes('你是我的角色。'))
  check('renders the release trigger', body.includes('切回普通模式'))
  check('renders no unresolved {{variable}}', !/\{\{[^{}]*\}\}/.test(body))
  seededStore.setActiveId(undefined)
  check('clearing the selection empties the section again', cardSection.text() === '')

  // ---------- default dir ----------
  console.log('\ndefault location')
  check('honours DSH_HOME', defaultStoreDir({ DSH_HOME: 'C:\\x\\.dsh' }).endsWith(path.join('x', '.dsh', 'persona-cards')) === false
    ? defaultStoreDir({ DSH_HOME: 'C:\\x\\.dsh' }) === path.join('C:\\x\\.dsh', 'persona-cards')
    : true)
  check('ends with persona-cards', defaultStoreDir({ DSH_HOME: 'C:\\x\\.dsh' }).endsWith(path.join('.dsh', 'persona-cards')))
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.log(`\nRESULT: FAILED (${failures.length}) -> ${failures.join('; ')}`)
  process.exit(1)
}
console.log('\nRESULT: OK — all checks passed')
