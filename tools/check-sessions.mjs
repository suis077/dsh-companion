/**
 * Offline checks for step 3: per-session overrides, the resolution rule, and
 * the Host plugin's tool.
 *
 * Everything runs against a throwaway directory under the OS temp dir — it never
 * reads or writes the real `$DSH_HOME/persona-cards`.
 *
 * Run: node tools/check-sessions.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionOverrides, resolveCard, normaliseOverride } from '../lib/sessions.mjs'
import { CardStore } from '../lib/cards.mjs'
import { apply, renderCard } from '../index.js'

const failures = []
function check (label, ok, detail) {
  if (ok) { console.log(`  PASS  ${label}`); return }
  failures.push(label)
  console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-sessions-'))
console.log(`dsh-persona-card session-override check\nworkdir: ${tmp}\n`)

try {
  // ---------------------- override normalisation ----------------------
  console.log('override normalisation')
  check('rejects a non-object', normaliseOverride('nope') === undefined)
  check('rejects a missing enabled flag', normaliseOverride({ cardId: 'x' }) === undefined)
  check('accepts enabled:false', normaliseOverride({ enabled: false })?.enabled === false)
  check('drops an empty cardId', normaliseOverride({ enabled: true, cardId: '  ' })?.cardId === undefined)

  // ---------------------- session store ----------------------
  console.log('\nsession store')
  const store = new SessionOverrides(path.join(tmp, 's1'))
  check('reads empty when the file is absent', Object.keys(store.readAll()).length === 0)
  check('get returns undefined for an unknown session', store.get('nope') === undefined)
  check('set writes an override', store.set('session-a', { enabled: false }).ok === true)
  check('get reads it back', store.get('session-a')?.enabled === false)
  check('invalid session id is refused', store.set('bad id!', { enabled: true }).ok === false)

  store.set('session-b', { enabled: true, cardId: 'testcard' })
  const all = store.readAll()
  check('two independent sessions coexist', all['session-a']?.enabled === false && all['session-b']?.cardId === 'testcard', JSON.stringify(all))
  check('session-a stayed off after writing session-b', store.get('session-a')?.enabled === false)

  check('clear removes one entry', store.clear('session-a') === 'removed')
  check('the other session survived the clear', store.get('session-b')?.cardId === 'testcard')
  check('clear on an absent id reports absent', store.clear('session-a') === 'absent')
  check('clear on a bad id reports invalid', store.clear('bad id!') === 'invalid')

  fs.writeFileSync(path.join(tmp, 's1', 'sessions.json'), '{ not json')
  check('a corrupt file degrades to empty, not a throw', Object.keys(store.readAll()).length === 0)

  // ---------------------- resolution rule ----------------------
  console.log('\nresolution rule')
  const cardA = { id: 'a', name: '甲', systemPrompt: 'p' }
  const cardB = { id: 'b', name: '乙', systemPrompt: 'q' }
  const getCard = (id) => (id === 'a' ? cardA : id === 'b' ? cardB : undefined)

  check('no override + global card -> inject it', resolveCard(undefined, cardA, getCard).card === cardA)
  check('  ...reason is "global"', resolveCard(undefined, cardA, getCard).reason === 'global')
  check('no override + no global -> nothing', resolveCard(undefined, undefined, getCard).card === undefined)
  check('enabled:false beats a global card', resolveCard({ enabled: false }, cardA, getCard).card === undefined)
  check('  ...reason is "session-disabled"', resolveCard({ enabled: false }, cardA, getCard).reason === 'session-disabled')
  check('a session-named card wins over the global one', resolveCard({ enabled: true, cardId: 'b' }, cardA, getCard).card === cardB)
  check('a missing named card injects NOTHING (never a substitute)', resolveCard({ enabled: true, cardId: 'ghost' }, cardA, getCard).card === undefined)
  check('  ...and says which id was wanted', resolveCard({ enabled: true, cardId: 'ghost' }, cardA, getCard).wanted === 'ghost')
  check('enabled:true with no cardId follows the global', resolveCard({ enabled: true }, cardA, getCard).card === cardA)

  // ---------------------- renderCard ----------------------
  console.log('\nrenderCard')
  check('undefined renders empty string', renderCard(undefined) === '')
  const rendered = renderCard(cardA)
  check('renders the header', rendered.startsWith('## 人设卡：甲'))
  check('renders no unresolved variable', !/\{\{[^{}]*\}\}/.test(rendered))
  const withTrigger = renderCard({ ...cardA, trigger: '切回普通模式' })
  check('renders the trigger line when present', withTrigger.includes('【解除本设定】切回普通模式'))
  check('omits the trigger line when absent', !rendered.includes('【解除本设定】'))

  // ---------------------- the plugin, two sessions ----------------------
  console.log('\nhost plugin: two sessions, one opted out')
  const hostDir = path.join(tmp, 'host')
  const sections = []
  const registered = []
  const promptService = { section: (s) => { sections.push(s); return () => {} } }
  const toolsService = { register: (d) => { registered.push(d); return () => {} } }
  const ctx = {
    logger: { warn: () => {} },
    inject: (deps, cb) => cb({
      get: (n) => (n === 'systemPrompt' ? promptService : n === 'tools' ? toolsService : undefined),
      effect: (fn) => { fn(); return {} },
    }),
  }

  // Set up a store with a user-created card, then activate it globally.
  const seeded = new CardStore(hostDir)
  fs.mkdirSync(hostDir, { recursive: true })
  seeded.upsert({ id: 'testcard', name: '测试角色', systemPrompt: '测试角色。', trigger: '切回普通模式' })
  seeded.setActiveId('testcard')

  apply(ctx, { storeDir: hostDir })

  check('registered the card section', sections.some((s) => s.name === 'persona-card'), sections.map((s) => s.name).join(','))
  check('registered one tool', registered.length === 1, String(registered.length))
  check('the tool is named persona_card', registered[0]?.name === 'persona_card', String(registered[0]?.name))

  const section = sections.find((s) => s.name === 'persona-card')
  const asAgent = (sessionId) => ({ agent: { session: { id: sessionId } } })

  const a = asAgent('session-a')
  const b = asAgent('session-b')

  check('session A follows the global card by default', section.text(a).includes('## 人设卡：测试角色'))
  check('session B follows the global card by default', section.text(b).includes('## 人设卡：测试角色'))

  // Turn session B off THROUGH THE TOOL — the real code path.
  const off = await registered[0].execute({ action: 'off' }, b)
  check('tool action=off succeeds', off.status === 'off', JSON.stringify(off))
  check('  ...session B now renders NOTHING', section.text(b) === '', JSON.stringify(section.text(b).slice(0, 40)))
  check('  ...session A still renders the card (no bleed)', section.text(a).includes('## 人设卡：测试角色'))

  // And back on.
  const on = await registered[0].execute({ action: 'on' }, b)
  check('tool action=on succeeds', on.status === 'on', JSON.stringify(on))
  check('  ...session B renders the card again', section.text(b).includes('## 人设卡：测试角色'))
  check('  ...session A is unaffected', section.text(a).includes('## 人设卡：测试角色'))

  // Per-session card selection.
  seeded.upsert({ id: 'other', name: '别的角色', systemPrompt: '你是别的角色。' })
  const use = await registered[0].execute({ action: 'use', cardId: 'other' }, b)
  check('tool action=use succeeds', use.status === 'use', JSON.stringify(use))
  check('  ...session B now uses the named card', section.text(b).includes('## 人设卡：别的角色'))
  check('  ...session A still uses the global card', section.text(a).includes('## 人设卡：测试角色'))

  // Unknown card is refused, and nothing is silently substituted.
  const bad = await registered[0].execute({ action: 'use', cardId: 'ghost' }, b)
  check('an unknown card is refused', bad.status === 'error', JSON.stringify(bad))
  check('  ...and the refusal lists available ids', bad.message.includes('other'), bad.message)

  // status / clear
  const st = await registered[0].execute({ action: 'status' }, a)
  check('action=status reports ok', st.status === 'ok')
  check('  ...and names the active card', st.activeCardId === 'testcard', JSON.stringify(st))

  const cl = await registered[0].execute({ action: 'clear' }, b)
  check('action=clear succeeds', cl.status === 'clear')
  check('  ...session B falls back to the global card', section.text(b).includes('## 人设卡：测试角色'))

  // The global switch steers everyone who has no override.
  seeded.setActiveId(undefined)
  check('clearing the global card empties session A', section.text(a) === '')
  check('  ...and session B too', section.text(b) === '')
  seeded.setActiveId('testcard')

  // A context without an agent cannot name a session, so it follows the global
  // default rather than guessing. This covers subagent/child assemblies.
  check('falls back to the global card when the context names no agent', section.text({}).includes('## 人设卡：测试角色'), JSON.stringify(section.text({}).slice(0, 40)))
  check('does the same for an undefined context (no throw)', section.text(undefined).includes('## 人设卡：测试角色'))
  seeded.setActiveId(undefined)
  check('and renders nothing once the global card is cleared', section.text({}) === '')
  seeded.setActiveId('testcard')

  // Tool without a session must refuse rather than write a junk key.
  const noSession = await registered[0].execute({ action: 'off' }, {})
  check('tool refuses when the session id is unavailable', noSession.status === 'error', JSON.stringify(noSession))
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.log(`\nRESULT: FAILED (${failures.length}) -> ${failures.join('; ')}`)
  process.exit(1)
}
console.log('\nRESULT: OK — all checks passed')
