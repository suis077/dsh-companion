/**
 * Inspect, back up, and restore persona memories.
 *
 * Why a separate CLI when the plugin already has `restore`:
 *   - the plugin only runs while DSH does, and the moment you most need this is
 *     when something has gone wrong;
 *   - this can also take a copy OUTSIDE `$DSH_HOME`, which is the only protection
 *     against the whole directory disappearing or the disk dying. The in-place
 *     `.bak` cannot help with that — it lives in the same folder.
 *
 * Usage:
 *   node tools/memory-doctor.mjs                 # 体检：每张卡的记忆状态
 *   node tools/memory-doctor.mjs --backup        # 把记忆复制到工作区 backups/
 *   node tools/memory-doctor.mjs --restore <cardId>  # 从 .bak 恢复某张卡
 *   node tools/memory-doctor.mjs --from <dir>    # 指定备份目录（默认同 --backup）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MemoryStore, memoriesDir } from '../lib/memory.mjs'
import { defaultStoreDir, CardStore } from '../lib/cards.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = path.join(HERE, '..')
/** Where an off-directory copy goes: inside the workspace, not `$DSH_HOME`. */
const OFF_DIR = path.join(PACKAGE_DIR, '..', '..', 'backups', 'persona-memory')

const storeDir = defaultStoreDir()
const memories = new MemoryStore(storeDir)
const cards = new CardStore(storeDir)

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const valueOf = (name) => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}

console.log(`记忆目录：${memoriesDir(storeDir)}`)

// ------------------------------------------------------------------ doctor
if (!flag('--restore') && !flag('--backup')) {
  const ids = memories.listIds()
  const cardIds = cards.list().map((c) => c.id)
  const all = [...new Set([...cardIds, ...ids])].sort()

  if (all.length === 0) {
    console.log('没有任何人设卡。')
    process.exit(0)
  }

  console.log('')
  let problems = 0
  for (const id of all) {
    const info = memories.inspect(id)
    const card = cards.get(id)
    const name = card?.name ?? '(卡不存在)'
    const n = info.memory.chapters.length
    const icon = info.state === 'ok' ? '✅' : info.state === 'corrupt' ? '❌' : info.hasBackup ? '⚠️' : '·'
    let line = `${icon} ${id.padEnd(16)} ${name.padEnd(12)} ${String(n).padStart(3)} 条  好感 ${String(info.memory.affinity).padStart(3)}`
    if (info.state === 'corrupt') { line += '  ← 文件读不出来'; problems += 1 }
    else if (info.state === 'missing' && info.hasBackup) { line += `  ← 主文件丢了，备份有 ${info.backupChapters} 条`; problems += 1 }
    else if (info.state === 'missing' && n === 0) { line += '  ← 还没有记忆' }
    console.log(line)
  }

  const offCount = fs.existsSync(OFF_DIR)
    ? fs.readdirSync(OFF_DIR).filter((f) => f.endsWith('.json')).length
    : 0
  console.log(`\n外部备份：${offCount === 0 ? '还没做过（跑 --backup）' : `${offCount} 份，在 ${OFF_DIR}`}`)
  if (problems > 0) console.log(`\n⚠️ ${problems} 张卡有问题，可以用 --restore <id> 试试从 .bak 恢复。`)
  process.exit(0)
}

// ------------------------------------------------------------------ backup
if (flag('--backup')) {
  fs.mkdirSync(OFF_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  let copied = 0
  for (const id of memories.listIds()) {
    const src = path.join(memoriesDir(storeDir), `${id}.json`)
    const dst = path.join(OFF_DIR, `${id}.${stamp}.json`)
    try {
      fs.copyFileSync(src, dst)
      copied += 1
    } catch (err) {
      console.error(`  复制 ${id} 失败：${String(err?.message ?? err)}`)
    }
  }
  console.log(`\n已复制 ${copied} 份记忆到：${OFF_DIR}`)
  console.log('（文件名带时间戳，旧备份不会被覆盖）')
  process.exit(0)
}

// ------------------------------------------------------------------ restore
const id = valueOf('--restore')
if (id === undefined) {
  console.error('用法：--restore <cardId>')
  process.exit(1)
}
const info = memories.inspect(id)
console.log(`\n当前状态：${info.state}，主文件 ${info.memory.chapters.length} 条，备份 ${info.backupChapters} 条`)
if (!info.hasBackup) {
  console.error('没有可用的 .bak 备份，无法恢复。')
  process.exit(1)
}
const result = memories.restore(id)
if (!result.ok) {
  console.error(`恢复失败：${result.problem}`)
  process.exit(1)
}
console.log(`已恢复：${result.memory.chapters.length} 条，好感 ${result.memory.affinity}/100`)
