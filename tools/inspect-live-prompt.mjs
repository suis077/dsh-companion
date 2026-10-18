/**
 * Decisive live check: decompress the session log and print the CURRENT
 * system prompt (the latest `system/message` surface node), so we can see with
 * our own eyes whether the persona section is really in the model's context.
 *
 * Node 24 ships zstd in `node:zlib`, so no external tool is needed.
 *
 * Usage:
 *   node tools/inspect-live-prompt.mjs                  # newest session, print prompt head
 *   node tools/inspect-live-prompt.mjs --grep 人设卡     # only print matching lines
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const sessionsRoot = path.join(DSH_HOME, 'sessions')

/** Newest session.v4.jsonl.zstd under sessions/, or undefined. */
function newestSessionLog () {
  let best
  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name === 'session.v4.jsonl.zstd') {
        const st = fs.statSync(p)
        if (best === undefined || st.mtimeMs > best.mtimeMs) best = { file: p, mtimeMs: st.mtimeMs, size: st.size }
      }
    }
  }
  walk(sessionsRoot)
  return best
}

/**
 * Decompress a .zstd file to a string.
 *
 * The session log is a concatenation of INDEPENDENT zstd frames — one per
 * appended event batch — and the stream decoder aborts on the seam ("Unknown
 * frame descriptor"). So split the buffer at each zstd frame magic
 * (28 B5 2F FD) and decode every frame on its own, then join the results.
 */
async function readZstd (file) {
  const buf = fs.readFileSync(file)
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  for (let i = 0; (i = buf.indexOf(MAGIC, i)) !== -1; i += 4) offsets.push(i)
  if (offsets.length === 0) return ''

  const parts = []
  let decoded = 0
  let failed = 0
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i]
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)))
      decoded += 1
    } catch {
      failed += 1
    }
  }
  console.error(`zstd frames: ${offsets.length} decoded=${decoded} failed=${failed}`)
  return Buffer.concat(parts).toString('utf8')
}

const target = newestSessionLog()
if (target === undefined) {
  console.error(`no session.v4.jsonl.zstd found under ${sessionsRoot}`)
  process.exit(1)
}
console.log(`session log : ${target.file}`)
console.log(`modified    : ${new Date(target.mtimeMs).toISOString()}`)
console.log(`compressed  : ${target.size} bytes`)

const text = await readZstd(target.file)
const lines = text.split('\n').filter((l) => l.trim() !== '')
console.log(`events      : ${lines.length}`)

// Find every system/message event; the last one is the live prompt.
const systems = []
for (const line of lines) {
  let ev
  try { ev = JSON.parse(line) } catch { continue }
  if (ev?.type === 'system/message') systems.push(ev)
}
console.log(`system/message events: ${systems.length}`)

const latest = systems.at(-1)
if (latest === undefined) {
  console.log('\n(no system/message event is present in this log)')
  process.exit(0)
}

const payload = latest.data ?? latest
// The event nests the wire message under `data.message`; older shapes put the
// content directly on the payload. Accept both rather than silently reading ''.
const message = payload?.message ?? payload
const blocks = Array.isArray(message?.content) ? message.content : []
const promptText = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')

console.log(`\nlatest system prompt: ${promptText.length} chars`)
console.log(`contains "人设卡"        : ${promptText.includes('人设卡')}`)
console.log(`contains step-1 placeholder: ${promptText.includes('骨架验证占位')}`)

const grepIdx = process.argv.indexOf('--grep')
if (grepIdx >= 0) {
  const needle = process.argv[grepIdx + 1] ?? ''
  console.log(`\n--- lines containing ${JSON.stringify(needle)} ---`)
  for (const l of promptText.split('\n')) if (l.includes(needle)) console.log(l)
} else {
  console.log('\n--- first 60 lines of the live system prompt ---')
  console.log(promptText.split('\n').slice(0, 60).join('\n'))
}
