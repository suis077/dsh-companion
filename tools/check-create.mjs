/**
 * Offline checks for the card-creation and whale-sync tool actions.
 *
 * These exercise the real tool body, so the asset validation rules, the id
 * derivation, and the "refuse rather than clobber" path are all covered.
 *
 * Run: node tools/check-create.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { CardStore, normaliseAssets, ASSET_KEYS } from '../lib/cards.mjs'
import { readStore } from '../lib/whale.mjs'

const failures = []
function check (label, ok, detail) {
  if (ok) { console.log(`  PASS  ${label}`); return }
  failures.push(label)
  console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-create-'))
console.log(`dsh-companion create/sync check\nworkdir: ${tmp}\n`)

// Captured before the try so the finally block can always restore it.
const realHome = process.env.DSH_HOME

try {
  // ---- asset validation --------------------------------------------------
  console.log('asset validation')
  check('allows an empty assets object', normaliseAssets({}).ok === true)
  check('treats undefined as empty', JSON.stringify(normaliseAssets(undefined).assets) === '{}')
  check('rejects a non-object', normaliseAssets('nope').ok === false)
  check('rejects an unknown key', normaliseAssets({ whatIsThis: 'C:\\x.png' }).ok === false)
  check('rejects a RELATIVE path', normaliseAssets({ roleImage: 'avatar.png' }).ok === false, JSON.stringify(normaliseAssets({ roleImage: 'avatar.png' })))
  check('rejects an absolute path whose file is absent', normaliseAssets({ roleImage: 'C:\\definitely\\not\\here.png' }).ok === false)
  check('accepts an absolute path that exists', (() => {
    const f = path.join(tmp, 'exists.png')
    fs.writeFileSync(f, Buffer.alloc(16))
    return normaliseAssets({ roleImage: f }).ok === true
  })())
  check('drops empty-string values', JSON.stringify(normaliseAssets({ roleImage: '' }).assets) === '{}')
  check('declares all four keys', ASSET_KEYS.length === 4, JSON.stringify(ASSET_KEYS))

  // ---- the tool, on a temp store -----------------------------------------
  const storeDir = path.join(tmp, 'cards')
  const homeDir = path.join(tmp, 'home')
  fs.mkdirSync(homeDir, { recursive: true })

  // A real source image, so installAsset has something to copy.
  const srcImg = path.join(tmp, 'src', 'me.png')
  fs.mkdirSync(path.dirname(srcImg), { recursive: true })
  fs.writeFileSync(srcImg, Buffer.alloc(128, 5))
  const srcWav = path.join(tmp, 'src', 'click.wav')
  fs.writeFileSync(srcWav, Buffer.alloc(128, 6))

  let capturedTool
  const ctx = {
    logger: { warn: () => {}, error: () => {} },
    root: {},
    inject: (deps, cb) => cb({
      get: (n) => (n === 'tools' ? { register: (d) => { capturedTool = d; return () => {} } } : undefined),
      effect: (fn) => { fn(); return {} },
    }),
  }

  // `dshHome()` is read at TOOL-CALL time, so the override must stay set for the
  // whole test body — not just around `apply()`.
  process.env.DSH_HOME = homeDir
  apply(ctx, { storeDir })

  check('the tool registered', capturedTool?.name === 'persona_card', String(capturedTool?.name))
  check('the schema exposes create', capturedTool?.parameters?.properties?.action?.enum?.includes('create') === true)
  check('the schema exposes sync', capturedTool?.parameters?.properties?.action?.enum?.includes('sync') === true)
  check('the schema exposes assets', capturedTool?.parameters?.properties?.assets !== undefined)

  const run = (args) => capturedTool.execute(args, {})

  // create refuses without the essentials
  const noName = await run({ action: 'create', systemPrompt: 'x' })
  check('create requires a name', noName.status === 'error', JSON.stringify(noName))
  const noPrompt = await run({ action: 'create', name: '甲' })
  check('create requires a systemPrompt', noPrompt.status === 'error', JSON.stringify(noPrompt))

  // create with a relative asset path must be refused, not silently dropped
  const badAsset = await run({ action: 'create', name: '甲', systemPrompt: '你是甲。', assets: { roleImage: 'relative.png' } })
  check('create refuses a relative asset path', badAsset.status === 'error', JSON.stringify(badAsset))

  // a successful create
  const ok = await run({ action: 'create', name: '甲', systemPrompt: '你是甲。', trigger: '切回普通模式' })
  check('create succeeds', ok.status === 'create', JSON.stringify(ok))

  const store = new CardStore(storeDir)
  // The plugin no longer ships a seed card, so OUR card is the only one.
  const cards = store.list()
  const made = cards.filter((c) => c.name === '甲')
  check('our card exists', made.length === 1, JSON.stringify(cards.map((c) => `${c.id}:${c.name}`)))
  check('only one card was created by this call', cards.length === 1, JSON.stringify(cards.map((c) => c.id)))
  const cardId = made[0].id
  check('the card name was kept', made[0].name === '甲')
  check('the trigger was kept', made[0].trigger === '切回普通模式')
  check('a non-ASCII name still yields a valid id', /^[a-z0-9][a-z0-9._-]*$/.test(cardId), cardId)

  // create with an explicit id updates in place
  const upd = await run({ action: 'create', cardId, name: '甲改', systemPrompt: '你是甲改。' })
  check('create with an existing id updates it', upd.status === 'create', JSON.stringify(upd))
  check('  ...and does not add a card', store.list().length === 1, String(store.list().length))
  check('  ...the content changed', store.get(cardId).name === '甲改')

  // makeActive
  const active = await run({ action: 'create', cardId, name: '甲改', systemPrompt: '你是甲改。', makeActive: true })
  check('makeActive selects the card', active.status === 'create' && new CardStore(storeDir).getActiveId() === cardId, JSON.stringify(active))

  // create WITH assets syncs them into the whale stores
  const withAssets = await run({
    action: 'create',
    cardId,
    name: '甲改',
    systemPrompt: '你是甲改。',
    assets: { roleImage: srcImg, pressSound: srcWav },
  })
  check('create with assets succeeds', withAssets.status === 'create', withAssets.message)
  check('  ...the message reports a successful sync', withAssets.message.includes('同步'), withAssets.message)

  const roleStore = readStore({ dir: path.join(homeDir, 'whale-roles'), kind: 'roles' })
  const audioStore = readStore({ dir: path.join(homeDir, 'whale-audio'), kind: 'audio' })
  check('a role entry landed', roleStore.ours.length === 1, JSON.stringify(roleStore.ours))
  check('an audio fragment landed', audioStore.ours.length === 1, JSON.stringify(audioStore.ours))
  check('the role index reports no problem', roleStore.problem === undefined, roleStore.problem)
  check('the audio index reports no problem', audioStore.problem === undefined, audioStore.problem)

  // A binding pointing at a missing file must be REFUSED at save time, and the
  // card's previously-good bindings must survive the refusal untouched.
  const beforeRefusal = new CardStore(storeDir).get(cardId)
  const missing = await run({
    action: 'create',
    cardId,
    name: '甲改',
    systemPrompt: '你是甲改。',
    assets: { bubbleImage: path.join(tmp, 'nope', 'ghost.png') },
  })
  check('a missing asset file is refused at save time', missing.status === 'error', JSON.stringify(missing))
  check('  ...and names the offending path', missing.message.includes('ghost.png'), missing.message)
  const afterRefusal = new CardStore(storeDir).get(cardId)
  check('  ...and the card\'s previous bindings are unchanged', JSON.stringify(afterRefusal.assets) === JSON.stringify(beforeRefusal.assets), JSON.stringify(afterRefusal.assets))

  // sync on a card with no assets is a clean no-op
  await run({ action: 'create', cardId: 'plain', name: '素卡', systemPrompt: '你是素卡。' })
  const noAssets = await run({ action: 'sync', cardId: 'plain' })
  check('sync on an asset-less card says so, without error', noAssets.status === 'sync' && noAssets.message.includes('没有绑定'), JSON.stringify(noAssets))

  // sync of the card that DOES have assets
  const sync = await run({ action: 'sync', cardId })
  check('sync of a bound card succeeds', sync.status === 'sync', JSON.stringify(sync))
  check('  ...and reports one line per asset', sync.message.split('\n').filter((l) => l.startsWith('✓')).length === 2, sync.message)

  // sync with an unknown id
  const syncGhost = await run({ action: 'sync', cardId: 'ghost' })
  check('sync of an unknown card errors', syncGhost.status === 'error', JSON.stringify(syncGhost))

  // list
  const list = await run({ action: 'list' })
  check('list succeeds', list.status === 'ok', JSON.stringify(list))
  check('  ...and names every card', list.message.includes(cardId) && list.message.includes('plain'), list.message)
  check('  ...and marks the active one', list.message.includes('全局生效'), list.message)

  // ---- the whale's own entries must survive a sync ------------------------
  console.log('\nwidget entries survive a sync')
  const roleIndexFile = path.join(homeDir, 'whale-roles', 'roles.json')
  const idx = JSON.parse(fs.readFileSync(roleIndexFile, 'utf8'))
  idx.roles.unshift({ id: '1700000000000', name: '小鲸鱼', pinnedAt: 1, createdAt: 0 })
  fs.writeFileSync(roleIndexFile, JSON.stringify(idx, null, 2))

  await run({ action: 'sync', cardId })
  const after = JSON.parse(fs.readFileSync(roleIndexFile, 'utf8'))
  check('the widget\'s own role survived a re-sync', after.roles.some((r) => r.id === '1700000000000' && r.name === '小鲸鱼'))
  check('  ...and our entry is still there exactly once', after.roles.filter((r) => r.name === '甲改').length === 1, JSON.stringify(after.roles.map((r) => r.name)))

  // ---- an unreadable index must make sync fail loudly, not clobber --------
  console.log('\nunreadable index')
  fs.writeFileSync(roleIndexFile, '{ broken')
  const before = fs.readFileSync(roleIndexFile, 'utf8')
  const syncBad = await run({ action: 'sync', cardId })
  check('sync fails when an index is unreadable', syncBad.status === 'error', JSON.stringify(syncBad))
  check('  ...and the broken file is left untouched', fs.readFileSync(roleIndexFile, 'utf8') === before)
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
