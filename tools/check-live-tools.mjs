/**
 * Check whether a named tool is present in the live tool schemas.
 *
 * Reads the newest session log and looks for the tool in the latest
 * `request/header` snapshot — the authoritative record of what the model was
 * told it could call. Also reports whether each plugin row actually activated,
 * by looking for its prompt section.
 *
 * This exists because a tool registration through `ctx.inject(['tools'])` is
 * easy to get wrong in a way no unit test can see: the stub hands the service
 * over directly, while the live loader may never call the callback.
 *
 * Run: node tools/check-live-tools.mjs [toolName]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

const wanted = process.argv[2] ?? 'persona_card'
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
if (!log) { console.error('no session log'); process.exit(1) }
console.log(`session log: ${log}\n`)

const events = []
for (const line of decodeLog(log).split('\n')) {
  if (line.trim() === '') continue
  try { events.push(JSON.parse(line)) } catch {}
}

// --- latest request/header: the tool schema snapshot -----------------------
const headers = events.filter((e) => e?.type === 'request/header')
console.log(`request/header events: ${headers.length}`)
const latestHeader = headers.at(-1)
const headerJson = JSON.stringify(latestHeader?.data ?? {})
const names = [...headerJson.matchAll(/"name":"([a-z0-9_]+)"/g)].map((m) => m[1])
const uniq = [...new Set(names)].sort()
console.log(`tool names seen in the latest header: ${uniq.length}`)
console.log(uniq.join(', '))

console.log(`\ncontains "${wanted}": ${uniq.includes(wanted)}`)

// --- which plugin prompt sections are live --------------------------------
const systems = events.filter((e) => e?.type === 'system/message')
const prompt = (systems.at(-1)?.data?.message?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
console.log('\n--- live prompt sections ---')
console.log(`persona card injected ("## 人设卡") : ${prompt.includes('## 人设卡')}`)
console.log(`todo board section ("## TODO 板")   : ${prompt.includes('## TODO 板')}`)

if (!uniq.includes(wanted)) {
  console.log(`\nRESULT: "${wanted}" is NOT registered in the live tool set.`)
  console.log('The prompt section can be live while a tool is not: they are separate services.')
  process.exit(1)
}
console.log(`\nRESULT: "${wanted}" IS registered and visible to the model.`)
