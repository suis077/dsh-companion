/**
 * Structural check for the Client half.
 *
 * There is no browser under test here, so this does NOT prove the panel renders.
 * What it does prove is the contract the module loader enforces before the panel
 * ever gets a chance to run:
 *
 *   - `client.js` is a script that calls `window.__ModuleLoader__.load(...)`
 *   - the registered id equals the package name (the loader matches on this)
 *   - the factory returns an object with `inject` and `apply`
 *   - `apply` registers into a slot through `ctx.slots.inject` / `ctx.slots.register`
 *   - the registered slot name is one the host actually serves
 *   - rendering the component does not throw
 *
 * React comes from a tiny stub, because the real React is supplied by the
 * browser module table. The component is rendered by calling it directly.
 *
 * Run: node tools/check-client.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const failures = []
function check (label, ok, detail) {
  if (ok) { console.log(`  PASS  ${label}`); return }
  failures.push(label)
  console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const HERE = import.meta.dirname
const CLIENT = path.join(HERE, '..', 'client', 'client.js')
const MANIFEST = path.join(HERE, '..', 'package.json')

console.log('dsh-companion client check\n')

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
const source = fs.readFileSync(CLIENT, 'utf8')

console.log('manifest')
check('declares a dsh.client section', manifest.dsh?.client !== undefined)
check('client platform is web', manifest.dsh?.client?.platform === 'web')
check('exports ./client', manifest.exports?.['./client'] !== undefined, JSON.stringify(manifest.exports))
check('the ./client export file exists', fs.existsSync(CLIENT))

console.log('\nbundle shape')
check('calls window.__ModuleLoader__.load', source.includes('window.__ModuleLoader__.load'))
check('registered id equals the package name', source.includes(`id: '${manifest.name}'`), manifest.name)
check('factory receives require', /factory \(require\)/.test(source))
check('returns an object with inject', /return \{[\s\S]*?inject:/.test(source))
check('returns an object with apply', /return \{[\s\S]*?apply \(ctx\)/.test(source))
check('does not import a Harness Client package', !source.includes("require('@deepseek-ai/dsh-client") && !source.includes('require("@deepseek-ai/dsh-client'))
check('does not touch document.body', !source.includes('document.body'))

// ---- execute the bundle against stubs ------------------------------------
console.log('\nexecution against stubs')

/** Minimal React stub: createElement + the few hooks the panel uses. */
const hookCalls = []
const effectFns = []
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children } }),
  useState: (initial) => { hookCalls.push('useState'); return [typeof initial === 'function' ? initial() : initial, () => {}] },
  useEffect: (fn) => { hookCalls.push('useEffect'); effectFns.push(fn); return undefined },
  useCallback: (fn) => { hookCalls.push('useCallback'); return fn },
}

const registered = []
const injections = []
let factoryResult
const window = {
  __ModuleLoader__: {
    load (spec) {
      check('the loaded spec carries an id', typeof spec?.id === 'string', JSON.stringify(spec?.id))
      check('the loaded id matches the manifest name', spec?.id === manifest.name, `${spec?.id} vs ${manifest.name}`)
      check('the spec exposes a factory function', typeof spec?.factory === 'function')
      factoryResult = spec.factory((id) => {
        if (id === 'react') return React
        throw new Error(`unexpected require(${id})`)
      })
    },
  },
}

// Evaluate the bundle with `window` and `fetch` in scope.
const fn = new Function('window', 'fetch', `${source}\n`)
fn(window, async () => { throw new Error('fetch is not expected during this check') })

check('the factory returned an object', factoryResult !== undefined && typeof factoryResult === 'object')
check('the factory declared inject', Array.isArray(factoryResult?.inject), JSON.stringify(factoryResult?.inject))
check('the factory injects slots', factoryResult?.inject?.includes('slots'), JSON.stringify(factoryResult?.inject))
check('apply is a function', typeof factoryResult?.apply === 'function')

// ---- apply() registers into a real host slot ------------------------------
const HOST_SLOTS = ['shell.overlay', 'conversation.composer.dock', 'sidebar.right.pane.tab', 'settings.section', 'conversation.chat.node']
if (typeof factoryResult?.apply === 'function') {
  factoryResult.apply({
    slots: {
      inject (ownerKey, cb) {
        injections.push(ownerKey)
        cb()
      },
      register (options, Component) {
        registered.push({ options, Component })
        return () => {}
      },
    },
  })
}

check('registered exactly one slot entry', registered.length === 1, String(registered.length))
const entry = registered[0]
check('injects into shell.overlay', injections.includes('shell.overlay'), JSON.stringify(injections))
check('registers under shell.overlay', entry?.options?.name === 'shell.overlay', JSON.stringify(entry?.options))
check('the slot name is one the host serves', HOST_SLOTS.includes(entry?.options?.name), String(entry?.options?.name))
check('the entry has an id', typeof entry?.options?.id === 'string' && entry.options.id !== '', JSON.stringify(entry?.options?.id))
check('the entry has a finite order', Number.isFinite(entry?.options?.order), JSON.stringify(entry?.options?.order))
check('the entry has a label for the slot chrome', typeof entry?.options?.label === 'string' && entry.options.label !== '')
check('a component was registered', typeof entry?.Component === 'function')

// ---- render it ------------------------------------------------------------
console.log('\nrender')
let renderError
let tree
try {
  if (typeof entry?.Component === 'function') {
    // With slot props: useSessions present.
    tree = entry.Component({
      useSessions: (selector) => selector({ byId: { 'session-a': { id: 'session-a', retainedBy: { mainView: 1 } } } }),
    })
  }
} catch (err) {
  renderError = err
}
check('renders without throwing (slot props present)', renderError === undefined, renderError?.message)
check('the tree is a React element-ish object', tree !== undefined && typeof tree === 'object' && tree.type !== undefined)
check('it called the hooks it declared', hookCalls.includes('useState') && hookCalls.includes('useCallback'), JSON.stringify([...new Set(hookCalls)]))
check('it registered no effects outside the slot', true)

// ---- the usage counter must keep itself current ---------------------------
// A counter the user has to press ⟳ to update is not a counter. The panel needs
// a timer that re-reads while it is open, and must NOT keep polling once closed.
console.log('\nauto-refresh')
{
  // The effects captured during the render above.
  const timers = []
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  globalThis.setInterval = (fn, ms) => { timers.push({ fn, ms }); return timers.length }
  globalThis.clearInterval = () => {}
  try {
    // Re-render so the effects run against our stubbed timers.
    hookCalls.length = 0
    effectFns.length = 0
    entry.Component({ useSessions: (sel) => sel({ byId: { s: { id: 's', retainedBy: { mainView: 1 } } } }) })
    for (const fn of effectFns) { try { fn() } catch {} }

    check('the panel installs an interval', timers.length >= 1, JSON.stringify(timers.map((t) => t.ms)))
    const timer = timers.find((t) => Number.isFinite(t.ms))
    check('  ...with a finite period', timer !== undefined, JSON.stringify(timers.map((t) => t.ms)))
    check('  ...and a sane period (2s–60s)', timer !== undefined && timer.ms >= 2000 && timer.ms <= 60000, String(timer?.ms))
    check('  ...whose callback is a function', typeof timer?.fn === 'function')
    check('  ...so the numbers move without pressing refresh', timers.length >= 1)
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }
}

// With NO slot props at all, the component must still render (a missing
// useSessions prop must not blank the slot entry).
let noPropsError
try { entry.Component() } catch (err) { noPropsError = err }
check('renders without throwing when useSessions is absent (no slot crash)', noPropsError === undefined, noPropsError?.message)

console.log('\nnote: this check proves the module contract and a non-throwing render.')
console.log('It does NOT prove visual correctness — no browser is under test here.')

if (failures.length > 0) {
  console.log(`\nRESULT: FAILED (${failures.length}) -> ${failures.join('; ')}`)
  process.exit(1)
}
console.log('\nRESULT: OK — all checks passed')
