/**
 * Offline checks for step M3: the memory actions on the persona_card tool.
 *
 * Exercises the real tool body through a stubbed context, so the schema wiring,
 * the card resolution, and the clamp/refusal paths are all covered.
 *
 * Run: node tools/check-remember.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { CardStore } from '../lib/cards.mjs'
import { MemoryStore } from '../lib/memory.mjs'

const failures = []
function check (label, ok, detail) {
  if (ok) { console.log(`  PASS  ${label}`); return }
  failures.push(label)
  console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-remember-'))
console.log(`dsh-persona-card memory-actions check\nworkdir: ${tmp}\n`)

const realHome = process.env.DSH_HOME
try {
  const storeDir = path.join(tmp, 'cards')
  fs.mkdirSync(storeDir, { recursive: true })

  // Seed two cards and make one globally active.
  const store = new CardStore(storeDir)
  store.upsert({ id: 'testcard', name: '测试角色', systemPrompt: '你是测试角色。', trigger: '切回普通模式' })
  store.upsert({ id: 'other', name: '别的角色', systemPrompt: '你是别的角色。' })
  store.setActiveId('testcard')

  let tool
  const ctx = {
    logger: { warn: () => {}, error: () => {} },
    root: {},
    inject: (deps, cb) => cb({
      get: (n) => (n === 'tools' ? { register: (d) => { tool = d; return () => {} } } : undefined),
      effect: (fn) => { fn(); return {} },
    }),
  }
  apply(ctx, { storeDir })

  check('the tool registered', tool?.name === 'persona_card', String(tool?.name))
  const enumValues = tool?.parameters?.properties?.action?.enum ?? []
  check('the schema exposes remember', enumValues.includes('remember'), JSON.stringify(enumValues))
  check('the schema exposes recall', enumValues.includes('recall'))
  check('the schema exposes mood', enumValues.includes('mood'))
  check('the schema exposes affinity', enumValues.includes('affinity'))
  check('the schema declares summary', tool?.parameters?.properties?.summary !== undefined)
  check('the schema declares delta', tool?.parameters?.properties?.delta !== undefined)

  // ---- remember / recall round-trip -------------------------------------
  console.log('\nremember + recall')
  const run = (args, exec) => tool.execute(args, exec)
  const sessionExec = { agent: { session: { id: 'session-x' } } }

  const empty = await run({ action: 'recall' }, sessionExec)
  check('recall on a fresh card says there is nothing yet', empty.status === 'recall' && empty.message.includes('还没有任何记忆'), empty.message)

  const rec = await run({
    action: 'remember',
    summary: '用户说他今天心情不错',
    feeling: '觉得他挺开心的',
    kind: 'chat',
    delta: 3,
  }, sessionExec)
  check('remember succeeds', rec.status === 'remember', JSON.stringify(rec))
  check('  ...and reports the new count', rec.message.includes('共 1 条'), rec.message)

  const after = await run({ action: 'recall' }, sessionExec)
  check('the chapter is readable back', after.message.includes('今天心情不错'), after.message.slice(0, 200))
  check('  ...with its feeling', after.message.includes('觉得他挺开心的'))
  check('  ...and the affinity moved', after.message.includes('好感 3/100'), after.message.slice(0, 120))

  // ---- summary is required ----------------------------------------------
  console.log('\nrefusals')
  const noSummary = await run({ action: 'remember' }, sessionExec)
  check('remember without a summary is refused', noSummary.status === 'error', JSON.stringify(noSummary))
  const blankSummary = await run({ action: 'remember', summary: '   ' }, sessionExec)
  check('a whitespace-only summary is refused', blankSummary.status === 'error')

  // ---- mood --------------------------------------------------------------
  console.log('\nmood')
  const mood = await run({ action: 'mood', mood: '嘴硬但尾巴在摇' }, sessionExec)
  check('mood succeeds', mood.status === 'mood', JSON.stringify(mood))
  check('  ...and is readable', (await run({ action: 'recall' }, sessionExec)).message.includes('嘴硬但尾巴在摇'))
  const noMood = await run({ action: 'mood' }, sessionExec)
  check('mood without a value is refused', noMood.status === 'error')

  // ---- affinity clamping -------------------------------------------------
  console.log('\naffinity (clamped, never rejected)')
  const up = await run({ action: 'affinity', delta: 200 }, sessionExec)
  check('a huge positive delta clamps at 100', up.message.includes('→ 100'), up.message)
  const down = await run({ action: 'affinity', delta: -999 }, sessionExec)
  check('a huge negative delta clamps at 0', down.message.includes('→ 0'), down.message)
  const abs = await run({ action: 'affinity', value: 42 }, sessionExec)
  check('an absolute value is honoured', abs.message.includes('→ 42'), abs.message)
  check('  ...and the message shows the signed change', abs.message.includes('+42'), abs.message)
  const neither = await run({ action: 'affinity' }, sessionExec)
  check('affinity with neither delta nor value is refused', neither.status === 'error')

  // ---- explicit cardId ---------------------------------------------------
  console.log('\nexplicit cardId')
  const other = await run({ action: 'remember', cardId: 'other', summary: '别的角色的事' }, sessionExec)
  check('an explicit cardId is honoured', other.status === 'remember', JSON.stringify(other))
  const mA = new MemoryStore(storeDir).read('testcard')
  const mB = new MemoryStore(storeDir).read('other')
  check('  ...written to that card only', mB.chapters.some((c) => c.summary === '别的角色的事'))
  check('  ...and not to the active card', !mA.chapters.some((c) => c.summary === '别的角色的事'))
  const ghost = await run({ action: 'remember', cardId: 'ghost', summary: 'x' }, sessionExec)
  check('an unknown cardId is refused', ghost.status === 'error', JSON.stringify(ghost))

  // ---- no active card ----------------------------------------------------
  console.log('\nno active card')
  store.setActiveId(undefined)
  const none = await run({ action: 'remember', summary: '没有卡' }, sessionExec)
  check('memory actions refuse without an active card', none.status === 'error', JSON.stringify(none))
  check('  ...and the message says how to fix it', none.message.includes('use'), none.message)
  // But an explicit cardId still works without an active card.
  const explicit = await run({ action: 'remember', cardId: 'testcard', summary: '没有活跃卡也能记' }, sessionExec)
  check('an explicit cardId works without an active card', explicit.status === 'remember', JSON.stringify(explicit))
  store.setActiveId('testcard')

  // ---- memory actions do not need a session ------------------------------
  console.log('\nsession independence')
  const noSession = await run({ action: 'remember', summary: '没有会话也能记' }, {})
  check('remember works even when no session is resolvable', noSession.status === 'remember', JSON.stringify(noSession))

  // ---- traits via remember ----------------------------------------------
  console.log('\ntraits')
  await run({ action: 'remember', summary: '夸它可爱', traits: ['嘴硬心软', '爱吃白饭'] }, sessionExec)
  const mt = new MemoryStore(storeDir).read('testcard')
  check('traits accumulate from remember', mt.traits.includes('嘴硬心软') && mt.traits.includes('爱吃白饭'), JSON.stringify(mt.traits))

  // ---- the rendered prompt carries the memory ---------------------------
  console.log('\nmemory reaches the prompt')
  // Re-register with a prompt service to capture the section text.
  let sectionText
  const ctx2 = {
    logger: { warn: () => {}, error: () => {} },
    root: {},
    inject: (deps, cb) => cb({
      get: (n) => (n === 'systemPrompt' ? { section: () => () => {} } : undefined),
      effect: () => ({}),
    }),
  }
  // Simpler: call the exported renderer directly against the same store.
  const { renderCard } = await import('../index.js')
  const { renderMemory } = await import('../lib/memory.mjs')
  const body = renderCard(store.get('testcard'), renderMemory(new MemoryStore(storeDir).read('testcard')))
  check('the rendered prompt contains the memory block', body.includes('与人相处的记忆'))
  check('  ...and a stored chapter', body.includes('今天心情不错'))
  check('  ...and sits AFTER the persona text', body.indexOf('你是测试角色') < body.indexOf('与人相处的记忆'))
} finally {
  if (realHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = realHome
  fs.rmSync(tmp, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.log(`\nRESULT: FAILED (${failures.length}) -> ${failures.join('; ')}`)
  process.exit(1)
}
console.log('\nRESULT: OK — all checks passed')
