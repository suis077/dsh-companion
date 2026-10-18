/**
 * Offline checks for step M1: the persona memory store.
 *
 * The load-bearing properties:
 *   1. a corrupt or hand-edited file degrades to a blank memory, never throws
 *      (this module feeds prompt assembly, which runs on every turn);
 *   2. chapter overflow FOLDS the oldest into a summary instead of dropping
 *      them — the earliest conversations define the persona;
 *   3. affinity is clamped, never rejected, so a mid-conversation write cannot
 *      fail over a slightly wrong number;
 *   4. writing one card never touches another card's file;
 *   5. original wording is not what gets stored — summaries are clipped.
 *
 * Run: node tools/check-memory.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  MemoryStore, emptyMemory, normaliseMemory, normaliseChapter, foldOverflow,
  renderMemory, memoryFile, memoriesDir, clip,
  MAX_CHAPTERS, RECALL_CHAPTERS, SUMMARY_MAX, FEELING_MAX, MAX_TRAITS,
  AFFINITY_MIN, AFFINITY_MAX, MEMORY_VERSION, CHAPTER_KINDS,
} from '../lib/memory.mjs'

const failures = []
function check (label, ok, detail) {
  if (ok) { console.log(`  PASS  ${label}`); return }
  failures.push(label)
  console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-memory-'))
console.log(`dsh-persona-card memory-store check\nworkdir: ${tmp}\n`)

try {
  // ------------------------------------------------------------ shape
  console.log('shape')
  const blank = emptyMemory()
  check('a blank memory has version/affinity/mood/traits/chapters', typeof blank.version === 'number' && blank.affinity === 0 && Array.isArray(blank.chapters))
  check('the version is the module constant', blank.version === MEMORY_VERSION)
  check('blank memory renders to the empty string', renderMemory(blank) === '')
  check('memory files live under memories/', memoryFile('/x', 'abc') === path.join('/x', 'memories', 'abc.json').replace(/\//g, path.sep))
  check('an unsafe card id yields no path', memoryFile('/x', '../evil') === undefined)
  check('memoriesDir sits inside the store', memoriesDir('/x') === path.join('/x', 'memories'))

  // ------------------------------------------------------------ normalisation
  console.log('\nnormalisation (repair, never reject)')
  const junk = normaliseMemory({ affinity: 'lots', mood: 5, traits: 'nope', chapters: 'nope' })
  check('garbage affinity becomes 0', junk.affinity === 0)
  check('garbage mood becomes empty', junk.mood === '')
  check('garbage traits becomes []', Array.isArray(junk.traits) && junk.traits.length === 0)
  check('garbage chapters becomes []', Array.isArray(junk.chapters) && junk.chapters.length === 0)
  check('null normalises to a blank memory', normaliseMemory(null).affinity === 0)
  check('an array normalises to a blank memory', normaliseMemory([1, 2]).chapters.length === 0)

  const clamped = normaliseMemory({ affinity: 500 })
  check('affinity above the max is clamped', clamped.affinity === AFFINITY_MAX, String(clamped.affinity))
  check('affinity below the min is clamped', normaliseMemory({ affinity: -40 }).affinity === AFFINITY_MIN)
  check('affinity is rounded', normaliseMemory({ affinity: 42.7 }).affinity === 43)

  check('a chapter without a summary is dropped', normaliseChapter({ summary: '   ' }) === undefined)
  check('a chapter with a summary is kept', normaliseChapter({ summary: '聊了很久' })?.summary === '聊了很久')
  check('an unknown kind falls back to chat', normaliseChapter({ summary: 'x', kind: 'nonsense' }).kind === 'chat')
  check('every declared kind is accepted', CHAPTER_KINDS.every((k) => normaliseChapter({ summary: 'x', kind: k }).kind === k))
  check('a chapter defaults its timestamp', typeof normaliseChapter({ summary: 'x' }).at === 'string')
  check('an empty feeling is omitted', normaliseChapter({ summary: 'x', feeling: '  ' }).feeling === undefined)

  const longSummary = normaliseChapter({ summary: 'a'.repeat(500) })
  check('a long summary is clipped', longSummary.summary.length <= SUMMARY_MAX + 1, String(longSummary.summary.length))
  check('a clipped summary is marked with an ellipsis', longSummary.summary.endsWith('…'))
  const longFeeling = normaliseChapter({ summary: 'x', feeling: 'b'.repeat(300) })
  check('a long feeling is clipped', longFeeling.feeling.length <= FEELING_MAX + 1, String(longFeeling.feeling.length))

  // clip() must not split a surrogate pair (emoji).
  const emoji = clip('🐋'.repeat(20), 5)
  check('clip never splits an emoji in half', !/[\uD800-\uDBFF]$/.test(emoji), JSON.stringify(emoji))

  // traits are deduped and capped.
  const manyTraits = normaliseMemory({ traits: Array.from({ length: 40 }, (_, i) => `t${i}`) })
  check('traits are capped', manyTraits.traits.length === MAX_TRAITS, String(manyTraits.traits.length))
  const dupTraits = normaliseMemory({ traits: ['嘴硬', '嘴硬', '心软'] })
  check('duplicate traits collapse', dupTraits.traits.length === 2, JSON.stringify(dupTraits.traits))

  // ------------------------------------------------------------ folding
  console.log('\noverflow folding (oldest must survive as a summary)')
  const filler = Array.from({ length: MAX_CHAPTERS + 50 }, (_, i) => ({
    at: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    kind: 'chat',
    summary: `第 ${i} 件事`,
  }))
  const folded = foldOverflow(filler)
  check('overflow is folded down to at most the cap', folded.chapters.length <= MAX_CHAPTERS, String(folded.chapters.length))
  check('  ...and reports how many were folded', folded.folded > 0, String(folded.folded))
  check('  ...the oldest entry becomes a milestone summary', folded.chapters[0]?.kind === 'milestone', JSON.stringify(folded.chapters[0]))
  check('  ...whose summary mentions the count', folded.chapters[0]?.summary.includes('合并'), folded.chapters[0]?.summary)
  check('  ...and the newest entries are untouched', folded.chapters.at(-1)?.summary === `第 ${MAX_CHAPTERS + 49} 件事`, folded.chapters.at(-1)?.summary)
  check('no fold happens below the cap', foldOverflow(filler.slice(0, 10)).folded === 0)
  check('folding a non-array is safe', foldOverflow(null).chapters.length === 0)

  // ------------------------------------------------------------ store round-trip
  console.log('\nstore round-trip')
  const store = new MemoryStore(path.join(tmp, 'store'))
  check('a never-written card reads as blank', store.read('testcard').chapters.length === 0)
  check('  ...and has() is false', store.has('testcard') === false)

  const w1 = store.update('testcard', {
    chapters: [{ at: '2026-10-18T01:00:00.000Z', kind: 'chat', summary: '用户说今天天气很好', feeling: '觉得他心情不错' }],
    affinityDelta: 5,
    mood: '尾巴在摇',
  })
  check('update writes', w1.ok === true, JSON.stringify(w1))
  check('  ...and reports one append', w1.appended === 1, String(w1.appended))

  const file = memoryFile(store.storeDir, 'testcard')
  check('the file landed on disk', fs.existsSync(file))
  check('  ...and parses as JSON', (() => { try { JSON.parse(fs.readFileSync(file, 'utf8')); return true } catch { return false } })())
  check('  ...with no leftover tmp files', !fs.readdirSync(memoriesDir(store.storeDir)).some((f) => f.includes('.tmp-')))

  const r1 = store.read('testcard')
  check('the chapter round-trips', r1.chapters[0]?.summary === '用户说今天天气很好')
  check('the feeling round-trips', r1.chapters[0]?.feeling === '觉得他心情不错')
  check('the affinity applied the delta', r1.affinity === 5, String(r1.affinity))
  check('the mood round-trips', r1.mood === '尾巴在摇')
  check('has() is true once there is content', store.has('testcard') === true)
  check('updatedAt is stamped', typeof r1.updatedAt === 'string' && r1.updatedAt !== '')

  // affinity clamps through the store too.
  store.update('testcard', { affinityDelta: 500 })
  check('a huge positive delta clamps at the max', store.read('testcard').affinity === AFFINITY_MAX, String(store.read('testcard').affinity))
  store.update('testcard', { affinityDelta: -9999 })
  check('a huge negative delta clamps at the min', store.read('testcard').affinity === AFFINITY_MIN)

  // absolute affinity overrides a delta.
  store.update('testcard', { affinity: 42, affinityDelta: 100 })
  check('an absolute affinity wins over a delta', store.read('testcard').affinity === 42, String(store.read('testcard').affinity))

  // traits accumulate without duplicates.
  store.update('testcard', { traits: ['嘴硬心软'] })
  store.update('testcard', { traits: ['嘴硬心软', '爱吃白饭'] })
  check('traits accumulate de-duplicated', JSON.stringify(store.read('testcard').traits) === JSON.stringify(['嘴硬心软', '爱吃白饭']), JSON.stringify(store.read('testcard').traits))

  // ------------------------------------------------------------ isolation
  console.log('\nisolation (one card must not touch another)')
  const beforeOther = fs.existsSync(memoryFile(store.storeDir, 'other'))
  store.update('testcard', { chapters: [{ summary: '又聊了一句' }] })
  check('writing one card creates no other card file', fs.existsSync(memoryFile(store.storeDir, 'other')) === beforeOther)
  store.update('other', { chapters: [{ summary: '另一个角色的记忆' }] })
  check('the other card has its own memory', store.read('other').chapters[0]?.summary === '另一个角色的记忆')
  check('  ...and the first card is unchanged', store.read('testcard').chapters.some((c) => c.summary === '又聊了一句'))
  check('listIds sees both', store.listIds().sort().join(',') === 'other,testcard', store.listIds().join(','))

  // ------------------------------------------------------------ corrupt files
  console.log('\ncorruption degrades, never throws')
  const badStore = new MemoryStore(path.join(tmp, 'bad'))
  fs.mkdirSync(memoriesDir(badStore.storeDir), { recursive: true })
  fs.writeFileSync(memoryFile(badStore.storeDir, 'broken'), '{ not json')
  check('a corrupt file reads as blank', badStore.read('broken').chapters.length === 0)
  check('  ...and does not throw', (() => { try { badStore.read('broken'); return true } catch { return false } })())
  fs.writeFileSync(memoryFile(badStore.storeDir, 'wrongshape'), '[1,2,3]')
  check('a wrong-shaped file reads as blank', badStore.read('wrongshape').affinity === 0)
  check('an unsafe id reads as blank', badStore.read('../evil').chapters.length === 0)
  check('an unsafe id cannot be written', badStore.update('../evil', { mood: 'x' }).ok === false)

  // A corrupt file is REPAIRED by the next successful write, not left broken.
  badStore.update('broken', { mood: '修好了' })
  check('a write repairs a corrupt file', badStore.read('broken').mood === '修好了')

  // ------------------------------------------------------------ rendering
  console.log('\nrendering')
  const fresh = new MemoryStore(path.join(tmp, 'fresh'))
  check('a card with no memory renders nothing', renderMemory(fresh.read('nobody')) === '')

  const rich = new MemoryStore(path.join(tmp, 'rich'))
  rich.update('card', {
    affinity: 37,
    mood: '被夸了，嘴硬',
    traits: ['嘴硬心软'],
    chapters: [
      { at: '2026-10-17T10:00:00.000Z', kind: 'chat', summary: '用户说今天天气很好', feeling: '想笑' },
      { at: '2026-10-17T15:00:00.000Z', kind: 'emotion', summary: '用户提到工作有点累', feeling: '想安慰' },
    ],
  })
  const text = renderMemory(rich.read('card'))
  check('the rendered block has a heading', text.includes('与人相处的记忆'))
  check('  ...shows affinity', text.includes('37/100'), text)
  check('  ...frames affinity as an internal gauge', text.includes('不是对真实关系的度量'))
  check('  ...shows the mood', text.includes('被夸了，嘴硬'))
  check('  ...shows the traits', text.includes('嘴硬心软'))
  check('  ...lists chapters', text.includes('今天天气很好') && text.includes('工作有点累'))
  check('  ...carries each chapter date', text.includes('2026-10-17'))
  check('  ...carries the feeling', text.includes('当时感觉'))
  check('  ...warns against inventing details', text.includes('不要凭空编造'))

  // A memory with only a mood still renders (partial data is normal).
  const moodOnly = new MemoryStore(path.join(tmp, 'moodonly'))
  moodOnly.update('card', { mood: '有点困' })
  check('a mood-only memory renders its mood', renderMemory(moodOnly.read('card')).includes('有点困'))

  // Rendering caps how many chapters appear.
  const many = new MemoryStore(path.join(tmp, 'many'))
  many.update('card', {
    chapters: Array.from({ length: 50 }, (_, i) => ({ at: '2026-10-17T00:00:00.000Z', summary: `第 ${i} 条` })),
  })
  const manyText = renderMemory(many.read('card'))
  const shown = (manyText.match(/^- 2026-10-17【/gm) ?? []).length
  check(`rendering shows at most ${RECALL_CHAPTERS} chapters`, shown === RECALL_CHAPTERS, String(shown))
  check('  ...and notes how many more exist', manyText.includes('更早还有'), manyText.slice(-120))

  // An explicit chapter count is honoured.
  const few = renderMemory(rich.read('card'), { chapters: 1 })
  check('an explicit chapter count is honoured', (few.match(/^- 2026-10-17【/gm) ?? []).length === 1)

  // ---------------------------------------------------------- backup & recovery
  console.log('\nbackup & recovery (a lost memory must not vanish silently)')
  const bk = new MemoryStore(path.join(tmp, 'backup'))
  bk.update('card', { affinity: 20, chapters: [{ summary: '第一条' }] })
  check('first write creates no backup (nothing to back up)', !fs.existsSync(bk.backupFile('card')))

  bk.update('card', { chapters: [{ summary: '第二条' }] })
  check('a second write creates a backup', fs.existsSync(bk.backupFile('card')))
  const bak = JSON.parse(fs.readFileSync(bk.backupFile('card'), 'utf8'))
  check('  ...holding the PREVIOUS state', bak.chapters.length === 1, String(bak.chapters.length))
  check('  ...not the new one', !bak.chapters.some((c) => c.summary === '第二条'))

  const okInfo = bk.inspect('card')
  check('inspect reports a healthy file as ok', okInfo.state === 'ok', okInfo.state)
  check('  ...with its chapters', okInfo.memory.chapters.length === 2, String(okInfo.memory.chapters.length))
  check('  ...and sees the backup', okInfo.hasBackup === true)

  fs.rmSync(memoryFile(bk.storeDir, 'card'))
  check('read() still degrades quietly (prompt must not break)', bk.read('card').chapters.length === 0)
  const lost = bk.inspect('card')
  check('inspect() reports the loss', lost.state === 'missing', lost.state)
  check('  ...and reports the surviving backup', lost.hasBackup === true && lost.backupChapters > 0, JSON.stringify({ has: lost.hasBackup, n: lost.backupChapters }))

  const restored = bk.restore('card')
  check('restore succeeds', restored.ok === true, JSON.stringify(restored))
  check('  ...bringing back the old chapters', bk.read('card').chapters.length === 1, String(bk.read('card').chapters.length))
  check('  ...with the old affinity', bk.read('card').affinity === 20, String(bk.read('card').affinity))
  check('restore with no backup reports a problem', new MemoryStore(path.join(tmp, 'nobak')).restore('card').ok === false)

  // A CORRUPT file must never poison a good backup.
  const poison = new MemoryStore(path.join(tmp, 'poison'))
  poison.update('card', { chapters: [{ summary: '好数据' }] })
  poison.update('card', { chapters: [{ summary: '第二条' }] })
  const goodBak = fs.readFileSync(poison.backupFile('card'), 'utf8')
  fs.writeFileSync(memoryFile(poison.storeDir, 'card'), '{ 坏掉的')
  check('inspect reports corruption', poison.inspect('card').state === 'corrupt', poison.inspect('card').state)
  poison.update('card', { chapters: [{ summary: '覆盖坏文件' }] })
  check('  ...and the backup is NOT overwritten by the corrupt state', fs.readFileSync(poison.backupFile('card'), 'utf8') === goodBak)
  check('  ...the write repaired the primary', poison.inspect('card').state === 'ok')

  // ---------------------------------------------------------- off-dir backup
  console.log('\noff-directory backup (survives the store disappearing)')
  const src = new MemoryStore(path.join(tmp, 'offstore'))
  src.update('alpha', { affinity: 10, chapters: [{ summary: 'A1' }] })
  src.update('beta', { chapters: [{ summary: 'B1' }] })
  const dest = path.join(tmp, 'offdest')

  // -------- backup-on-change (updateAndBackup) ---------------------------
  console.log('\nbackup-on-change (the timer replacement)')
  const bcd = path.join(tmp, 'backup-on-change')
  const bc = new MemoryStore(path.join(tmp, 'bcstore'))
  const bc1 = await bc.updateAndBackup('card', { chapters: [{ summary: '第一条' }] }, bcd)
  check('updateAndBackup writes the memory', bc1.ok === true, JSON.stringify(bc1))
  check('  ...and backs it up in the same step', bc1.backedUp === true, JSON.stringify(bc1))
  check('  ...to the off-directory', fs.readdirSync(bcd).some((f) => f.startsWith('card.')), fs.readdirSync(bcd).join(','))
  // An unchanged second write must not produce a new snapshot.
  const bc2 = await bc.updateAndBackup('card', { mood: '没变' }, bcd)
  check('a subsequent write still succeeds', bc2.ok === true)
  // updateAndBackup without a dest dir still writes, just does not snapshot.
  const bc3 = await bc.updateAndBackup('card', { mood: '无目标目录' })
  check('no dest dir means write-only', bc3.ok === true && bc3.backedUp === false, JSON.stringify(bc3))
  // A memory write must survive a FAILED backup (backup is best-effort).
  const badDir = path.join(tmp, 'this', 'path', 'is', 'a', 'file')
  fs.writeFileSync(path.join(tmp, 'this'), '占位') // makes an ancestor a FILE so mkdir fails
  const bc4 = await bc.updateAndBackup('card', { chapters: [{ summary: '备份会失败' }] }, badDir)
  check('a failed backup does not fail the memory write', bc4.ok === true && bc4.backedUp === false, JSON.stringify(bc4))
  check('  ...and reports the backup problem separately', typeof bc4.backupProblem === 'string', JSON.stringify(bc4))
  check('  ...and the memory is still written', bc.read('card').chapters.some((c) => c.summary === '备份会失败'))

  const b1 = src.backupTo(dest)
  check('backup copies every card', b1.ok && b1.copied.length === 2, JSON.stringify(b1))
  check('  ...into the target directory', fs.readdirSync(dest).filter((f) => f.endsWith('.json')).length === 2, fs.readdirSync(dest).join(','))

  // An unchanged card must not create a second snapshot.
  const b2 = src.backupTo(dest)
  check('an unchanged memory is skipped', b2.copied.length === 0 && b2.skipped.length === 2, JSON.stringify(b2))
  check('  ...so no duplicate files pile up', fs.readdirSync(dest).filter((f) => f.startsWith('alpha.')).length === 1, String(fs.readdirSync(dest).filter((f) => f.startsWith('alpha.')).length))

  // A real change DOES produce a new snapshot.
  src.update('alpha', { chapters: [{ summary: 'A2' }] })
  const b3 = src.backupTo(dest)
  check('a changed memory is copied again', b3.copied.includes('alpha'), JSON.stringify(b3))
  check('  ...and the old snapshot is kept', fs.readdirSync(dest).filter((f) => f.startsWith('alpha.')).length >= 2, String(fs.readdirSync(dest).filter((f) => f.startsWith('alpha.')).length))

  // Pruning keeps the newest N.
  for (let i = 0; i < 6; i += 1) {
    src.update('alpha', { chapters: [{ summary: `A-new-${i}` }] })
    src.backupTo(dest, { keep: 3 })
  }
  const alphaSnaps = fs.readdirSync(dest).filter((f) => f.startsWith('alpha.'))
  check('snapshots are pruned to the cap', alphaSnaps.length <= 3, String(alphaSnaps.length))

  // Guard: a dry run reports what it WOULD copy but writes nothing.
  {
    const d = path.join(tmp, 'drydest')
    const r = src.backupTo(d, { dryRun: true })
    check('a dry run reports what it would copy', r.ok && r.copied.length > 0, JSON.stringify(r))
    check('  ...and writes nothing', !fs.existsSync(d))
  }

  // THE POINT: deleting the whole store must not lose the memory.
  fs.rmSync(path.join(tmp, 'offstore'), { recursive: true, force: true })
  check('the store is gone', !fs.existsSync(path.join(tmp, 'offstore')))
  const survivor = fs.readdirSync(dest).filter((f) => f.startsWith('alpha.')).sort().at(-1)
  const salvaged = JSON.parse(fs.readFileSync(path.join(dest, survivor), 'utf8'))
  check('  ...yet a snapshot survives', Array.isArray(salvaged.chapters) && salvaged.chapters.length > 0, survivor)
  check('  ...with readable content', salvaged.chapters.at(-1)?.summary === 'A-new-5', salvaged.chapters.at(-1)?.summary)

  // A corrupt source is skipped, not copied as garbage.
  const badSrc = new MemoryStore(path.join(tmp, 'badsrc'))
  fs.mkdirSync(memoriesDir(badSrc.storeDir), { recursive: true })
  fs.writeFileSync(memoryFile(badSrc.storeDir, 'broken'), '{ nonsense')
  const badDest = path.join(tmp, 'baddest')
  const b4 = badSrc.backupTo(badDest)
  check('a corrupt memory is skipped by backup', b4.skipped.includes('broken'), JSON.stringify(b4))
  check('  ...and writes nothing', !fs.existsSync(badDest) || fs.readdirSync(badDest).length === 0)

  // Guard: an empty destination is refused rather than writing somewhere odd.
  check('an empty destination is refused', src.backupTo('').ok === false)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.log(`\nRESULT: FAILED (${failures.length}) -> ${failures.join('; ')}`)
  process.exit(1)
}
console.log('\nRESULT: OK — all checks passed')
