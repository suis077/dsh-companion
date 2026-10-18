/**
 * Offline checks for step 5: the whale-widget asset bridge.
 *
 * The point of these checks is the SAFETY property: the bridge must merge into
 * the widget's indexes without ever destroying the widget's own entries, and it
 * must refuse to write rather than guess when an index is unreadable.
 *
 * Everything runs under the OS temp dir; the real `$DSH_HOME/whale-*`
 * directories are never touched.
 *
 * Run: node tools/check-whale.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mergeStore, installAsset, readStore, assetId, isOurs, normaliseFormat, storeDir, STORES, ID_PREFIX } from '../lib/whale.mjs'

const failures = []
function check (label, ok, detail) {
  if (ok) { console.log(`  PASS  ${label}`); return }
  failures.push(label)
  console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-whale-'))
console.log(`dsh-companion whale-bridge check\nworkdir: ${tmp}\n`)

/** Write a 1x1 PNG header so a "real" image file exists. */
function fakeImage (file, bytes = 64) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.alloc(bytes, 7))
  return file
}

try {
  // ------------------------------------------------ ids
  console.log('ids')
  check('assetId carries the plugin prefix', assetId('testcard', 'role', 'avatar').startsWith(ID_PREFIX))
  check('isOurs accepts our ids', isOurs(assetId('a', 'role', 'x')) === true)
  check('isOurs rejects a widget id', isOurs('1751234567890') === false)
  check('assetId strips unsafe characters', !/[^A-Za-z0-9_-]/.test(assetId('a/b c', 'role', '../../evil')))
  check('assetId stays within the 64-char id limit', assetId('x'.repeat(50), 'role', 'y'.repeat(50)).length <= 64, String(assetId('x'.repeat(50), 'role', 'y'.repeat(50)).length))
  check('normaliseFormat defaults to png', normaliseFormat(undefined) === 'png' && normaliseFormat('gif') === 'gif' && normaliseFormat('webp') === 'png')

  // ------------------------------------------------ merge on a fresh store
  console.log('\nmerge into an empty store')
  const rolesDir = path.join(tmp, 'whale-roles')
  const img = fakeImage(path.join(tmp, 'src', 'avatar.png'))
  const rid = assetId('testcard', 'role', 'avatar')
  const a1 = installAsset({ dir: rolesDir, kind: 'roles', id: rid, sourceFile: img })
  check('installAsset copies the file', a1.ok === true && fs.existsSync(a1.file), JSON.stringify(a1))
  const m1 = mergeStore({ dir: rolesDir, kind: 'roles', add: [{ id: rid, name: '测试角色', format: 'png', createdAt: 111 }] })
  check('mergeStore succeeds', m1.ok === true, JSON.stringify(m1))
  check('  ...reports one addition', m1.added === 1 && m1.updated === 0, JSON.stringify(m1))
  const idx1 = JSON.parse(fs.readFileSync(path.join(rolesDir, 'roles.json'), 'utf8'))
  check('  ...the index has a version', idx1.version === 1)
  check('  ...our entry landed', idx1.roles.some((r) => r.id === rid && r.name === '测试角色'))
  check('  ...no leftover .tmp file', !fs.readdirSync(rolesDir).some((f) => f.includes('.tmp-')), fs.readdirSync(rolesDir).join(','))

  // ------------------------------------------------ THE property: never clobber
  console.log('\nmerge must never clobber the widget\'s own entries')
  const widgetDir = path.join(tmp, 'owned')
  fs.mkdirSync(widgetDir, { recursive: true })
  // A widget-owned index, exactly as the widget writes it.
  const widgetRole = { id: '1700000000000', name: '小鲸鱼改', pinnedAt: 1, createdAt: 0 }
  const widgetRole2 = { id: '1700000000001', name: '我自己的角色', createdAt: 5 }
  fs.writeFileSync(path.join(widgetDir, 'roles.json'), JSON.stringify({ version: 1, roles: [widgetRole, widgetRole2] }, null, 2))

  const rid2 = assetId('testcard', 'role', 'second')
  installAsset({ dir: widgetDir, kind: 'roles', id: rid2, sourceFile: img })
  const m2 = mergeStore({ dir: widgetDir, kind: 'roles', add: [{ id: rid2, name: '插件加的', format: 'png', createdAt: 222 }] })
  check('merge into a populated index succeeds', m2.ok === true, JSON.stringify(m2))
  const idx2 = JSON.parse(fs.readFileSync(path.join(widgetDir, 'roles.json'), 'utf8'))
  check('the widget\'s first entry survived', idx2.roles.some((r) => r.id === '1700000000000' && r.name === '小鲸鱼改'))
  check('the widget\'s second entry survived', idx2.roles.some((r) => r.id === '1700000000001'))
  check('our entry was added alongside them', idx2.roles.some((r) => r.id === rid2))
  check('nothing was dropped', idx2.roles.length === 3, String(idx2.roles.length))

  // Refuse to write a non-plugin id — the guard against a collision rewriting
  // someone else's entry.
  const m3 = mergeStore({ dir: widgetDir, kind: 'roles', add: [{ id: '1700000000001', name: '劫持' }] })
  check('refuses to write a non-plugin id', m3.ok === false, JSON.stringify(m3))
  const idx3 = JSON.parse(fs.readFileSync(path.join(widgetDir, 'roles.json'), 'utf8'))
  check('  ...and the widget entry is untouched', idx3.roles.find((r) => r.id === '1700000000001').name === '我自己的角色')

  // Update in place, by id.
  const m4 = mergeStore({ dir: widgetDir, kind: 'roles', add: [{ id: rid2, name: '改名了', format: 'png' }] })
  check('an existing id is updated, not duplicated', m4.updated === 1 && m4.added === 0, JSON.stringify(m4))
  const idx4 = JSON.parse(fs.readFileSync(path.join(widgetDir, 'roles.json'), 'utf8'))
  check('  ...the count did not grow', idx4.roles.length === 3, String(idx4.roles.length))
  check('  ...the name changed', idx4.roles.find((r) => r.id === rid2).name === '改名了')

  // ------------------------------------------------ pruning
  console.log('\npruning')
  fs.rmSync(path.join(widgetDir, `${rid2}.png`))
  const m5 = mergeStore({ dir: widgetDir, kind: 'roles', add: [] })
  check('an entry whose file vanished is pruned', m5.pruned === 1, JSON.stringify(m5))
  const idx5 = JSON.parse(fs.readFileSync(path.join(widgetDir, 'roles.json'), 'utf8'))
  check('  ...our dead entry is gone', !idx5.roles.some((r) => r.id === rid2))
  check('  ...widget entries are NOT pruned', idx5.roles.length === 2, String(idx5.roles.length))

  // ------------------------------------------------ refuse on unreadable index
  console.log('\nrefusal on an unreadable index')
  const badDir = path.join(tmp, 'bad')
  fs.mkdirSync(badDir, { recursive: true })
  fs.writeFileSync(path.join(badDir, 'roles.json'), '{ this is not json')
  const before = fs.readFileSync(path.join(badDir, 'roles.json'), 'utf8')
  const m6 = mergeStore({ dir: badDir, kind: 'roles', add: [{ id: rid, name: 'x' }] })
  check('an unreadable index is refused', m6.ok === false, JSON.stringify(m6))
  check('  ...and left byte-for-byte alone', fs.readFileSync(path.join(badDir, 'roles.json'), 'utf8') === before)
  check('  ...with an explanatory problem', (m6.problem ?? '').includes('roles.json'), m6.problem)

  const wrongShape = path.join(tmp, 'wrongshape')
  fs.mkdirSync(wrongShape, { recursive: true })
  fs.writeFileSync(path.join(wrongShape, 'roles.json'), JSON.stringify({ version: 1, somethingElse: [] }))
  const m7 = mergeStore({ dir: wrongShape, kind: 'roles', add: [{ id: rid, name: 'x' }] })
  check('an index without the expected array is refused', m7.ok === false, JSON.stringify(m7))

  // ------------------------------------------------ audio + bubble shapes
  console.log('\naudio (fragments + groups)')
  const audioDir = path.join(tmp, 'whale-audio')
  const wav = path.join(tmp, 'src', 'ya.wav')
  fs.writeFileSync(wav, Buffer.alloc(64, 3))
  const aid = assetId('testcard', 'audio', 'press')
  installAsset({ dir: audioDir, kind: 'audio', id: aid, sourceFile: wav })
  const ma = mergeStore({ dir: audioDir, kind: 'audio', add: [{ id: aid, name: '按压', createdAt: 5 }] })
  check('audio merge succeeds', ma.ok === true, JSON.stringify(ma))
  const aidx = JSON.parse(fs.readFileSync(path.join(audioDir, 'audio.json'), 'utf8'))
  check('  ...fragments array holds the entry', Array.isArray(aidx.fragments) && aidx.fragments.some((f) => f.id === aid))
  check('  ...groups array exists (the widget requires it)', Array.isArray(aidx.groups))
  check('  ...file is named <id>.wav', fs.existsSync(path.join(audioDir, `${aid}.wav`)))

  // A pre-existing groups array must be preserved.
  fs.writeFileSync(path.join(audioDir, 'audio.json'), JSON.stringify({ version: 1, groups: [{ id: 'g1', name: '我的音效组' }], fragments: [] }))
  const ma2 = mergeStore({ dir: audioDir, kind: 'audio', add: [{ id: aid, name: '按压', createdAt: 5 }] })
  const aidx2 = JSON.parse(fs.readFileSync(path.join(audioDir, 'audio.json'), 'utf8'))
  check('  ...a pre-existing group survives the merge', ma2.ok === true && aidx2.groups.some((g) => g.id === 'g1'), JSON.stringify(aidx2.groups))

  console.log('\nbubble images')
  const bubDir = path.join(tmp, 'whale-bubble-imgs')
  const gif = path.join(tmp, 'src', 'pet.gif')
  fs.writeFileSync(gif, Buffer.alloc(64, 9))
  const bid = assetId('testcard', 'bubbleImgs', 'pet')
  installAsset({ dir: bubDir, kind: 'bubbleImgs', id: bid, sourceFile: gif })
  const mb = mergeStore({ dir: bubDir, kind: 'bubbleImgs', add: [{ id: bid, name: 'pet', format: 'gif', createdAt: 7 }] })
  check('bubble merge succeeds', mb.ok === true, JSON.stringify(mb))
  const bidx = JSON.parse(fs.readFileSync(path.join(bubDir, 'bubble-imgs.json'), 'utf8'))
  check('  ...images array holds the entry', bidx.images.some((i) => i.id === bid))
  check('  ...gif format is preserved', bidx.images.find((i) => i.id === bid).format === 'gif')
  check('  ...file is named <id>.gif', fs.existsSync(path.join(bubDir, `${bid}.gif`)))
  check('  ...built-in ids are never reused by us', !bid.startsWith('bimg_') || bid.startsWith(ID_PREFIX))

  // ------------------------------------------------ idempotence
  console.log('\nidempotence')
  const r1 = mergeStore({ dir: rolesDir, kind: 'roles', add: [{ id: rid, name: '测试角色', format: 'png', createdAt: 111 }] })
  const r2 = mergeStore({ dir: rolesDir, kind: 'roles', add: [{ id: rid, name: '测试角色', format: 'png', createdAt: 111 }] })
  check('re-merging the same entry is stable', r1.ok === true && r2.ok === true && r2.added === 0, JSON.stringify(r2))
  const fileAfter = JSON.parse(fs.readFileSync(path.join(rolesDir, 'roles.json'), 'utf8'))
  check('  ...only one copy exists', fileAfter.roles.filter((r) => r.id === rid).length === 1)

  const skip = installAsset({ dir: rolesDir, kind: 'roles', id: rid, sourceFile: img })
  check('re-installing an identical asset is skipped', skip.ok === true && skip.skipped === true, JSON.stringify(skip))

  // ------------------------------------------------ dry run
  console.log('\ndry run')
  const dryDir = path.join(tmp, 'dry')
  fs.mkdirSync(dryDir, { recursive: true })
  const md = mergeStore({ dir: dryDir, kind: 'roles', add: [{ id: rid, name: 'x', format: 'png' }], dryRun: true })
  check('dry run reports success', md.ok === true, JSON.stringify(md))
  check('  ...but wrote no file', !fs.existsSync(path.join(dryDir, 'roles.json')))

  // ------------------------------------------------ readStore
  console.log('\nreadStore')
  const rs = readStore({ dir: rolesDir, kind: 'roles' })
  check('readStore finds our entries', rs.ours.length >= 1, String(rs.ours.length))
  check('readStore reports no problem on a good index', rs.problem === undefined)
  const rsBad = readStore({ dir: badDir, kind: 'roles' })
  check('readStore flags an unreadable index', rsBad.problem !== undefined, rsBad.problem)

  // ------------------------------------------------ directory names
  console.log('\ndirectory names must match what the widget reads')
  check('roles dir is whale-roles', STORES.roles.dirName === 'whale-roles')
  check('audio dir is whale-audio', STORES.audio.dirName === 'whale-audio')
  check('bubble dir is whale-bubble-imgs', STORES.bubbleImgs.dirName === 'whale-bubble-imgs')
  check('roles index is roles.json', STORES.roles.indexName === 'roles.json')
  check('audio index is audio.json', STORES.audio.indexName === 'audio.json')
  check('bubble index is bubble-imgs.json', STORES.bubbleImgs.indexName === 'bubble-imgs.json')
  check('storeDir joins the home and the dir name', storeDir('C:\\x', 'roles') === path.join('C:\\x', 'whale-roles'))
  check('an unknown store throws', (() => { try { storeDir('C:\\x', 'nope'); return false } catch { return true } })())
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.log(`\nRESULT: FAILED (${failures.length}) -> ${failures.join('; ')}`)
  process.exit(1)
}
console.log('\nRESULT: OK — all checks passed')
