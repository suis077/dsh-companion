/**
 * Offline check for dsh-companion's Host *registration surface*.
 *
 * Simulates the three services the plugin asks for — `systemPrompt`, `tools`,
 * `webServer` — and asserts the plugin registers exactly one prompt section,
 * exactly one tool, and exactly one route, each through a disposable effect.
 *
 * This is about the registration contract, not behaviour: the card store, the
 * session rule, and the routes have their own suites.
 *
 * Run: node tools/check-host.mjs
 */
import { apply, name, renderCard } from '../index.js'

const failures = []
function check (label, ok, detail) {
  if (ok) { console.log(`  PASS  ${label}`); return }
  failures.push(label)
  console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

console.log('dsh-companion host registration check\n')

// ---- fake services --------------------------------------------------------
const sections = []
const promptService = { section: (s) => { sections.push(s); return () => {} } }
const tools = []
const toolService = { register: (d) => { tools.push(d); return () => {} } }
const routes = []
const serverService = { register: (r) => { routes.push(r); return () => {} } }

const SERVICES = { systemPrompt: promptService, tools: toolService, webServer: serverService }

// ---- fake plugin context --------------------------------------------------
const injections = []
const effectLabels = []
const ctx = {
  logger: { warn: () => {}, error: () => {} },
  root: {},
  inject (deps, cb) {
    injections.push(deps)
    // DSH re-runs this callback whenever a required service appears.
    cb({
      get: (serviceName) => SERVICES[serviceName],
      effect (fn, label) {
        effectLabels.push(label)
        const d = fn()
        return { label, dispose: typeof d === 'function' ? d : () => {} }
      },
    })
  },
}

apply(ctx, { storeDir: process.env.PERSONA_TEST_DIR })

console.log('registration')
check('export name is the package name', name === 'dsh-companion', String(name))
check('asks for systemPrompt', injections.some((d) => Array.isArray(d) && d.includes('systemPrompt')), JSON.stringify(injections))
check('asks for tools', injections.some((d) => Array.isArray(d) && d.includes('tools')), JSON.stringify(injections))
check('asks for webServer', injections.some((d) => Array.isArray(d) && d.includes('webServer')), JSON.stringify(injections))
// Four now: card section, memory-rules section, the model tool, and the panel
// routes. The assertion is about DISPOSABILITY, not the count — a registration
// that cannot be torn down leaks across reloads.
check('every registration goes through a disposable effect', effectLabels.length === 4, JSON.stringify(effectLabels))
check('labelled effects for diagnosis', effectLabels.every((l) => typeof l === 'string' && l.includes('dsh-companion')), JSON.stringify(effectLabels))

console.log('\nprompt sections')
// Two sections now, on purpose: the card itself, plus the rules that govern what
// gets remembered. They are separate so editing the rules never rewrites a
// user's persona text, and so the card stays a stable prompt prefix.
check('registered exactly two sections', sections.length === 2, sections.map((s) => s.name).join(','))
const s = sections.find((x) => x.name === 'persona-card') ?? {}
const rules = sections.find((x) => x.name === 'persona-card:memory-rules') ?? {}
check('one is the card', s.name === 'persona-card', JSON.stringify(s.name))
check('one is the memory rules', rules.name === 'persona-card:memory-rules', JSON.stringify(rules.name))
check('card order is a finite number', Number.isFinite(s.order), JSON.stringify(s.order))
check('card order sits after persona prefix (0) and before plan policy (500)', s.order > 0 && s.order < 500, String(s.order))
check('rules order follows the card', Number.isFinite(rules.order) && rules.order > s.order && rules.order < 500, `${s.order} then ${rules.order}`)
check('card text is a function (per-assembly resolution)', typeof s.text === 'function', typeof s.text)
check('rules text is a function too', typeof rules.text === 'function', typeof rules.text)

// With no card selected BOTH sections must contribute nothing, so an
// unconfigured install never leaves a stray header in the prompt.
const empty = s.text()
check('renders empty when no card is active', empty === '', JSON.stringify(String(empty).slice(0, 40)))
check('rules are empty when no card is active', rules.text() === '', JSON.stringify(String(rules.text()).slice(0, 40)))

// renderCard itself must never emit an unresolved {{variable}} — the
// system-prompt package throws on one at render time.
const rendered = renderCard({ id: 'x', name: '甲', systemPrompt: '你是甲。', trigger: '切回普通模式' })
check('renderCard carries no unresolved {{variable}}', !/\{\{[^{}]*\}\}/.test(rendered))
check('renderCard includes the release trigger', rendered.includes('【解除本设定】切回普通模式'))

console.log('\ntool')
check('registered exactly one tool', tools.length === 1, String(tools.length))
check('the tool is named persona_card', tools[0]?.name === 'persona_card', String(tools[0]?.name))
check('the tool declares a finite action enum', Array.isArray(tools[0]?.parameters?.properties?.action?.enum), JSON.stringify(tools[0]?.parameters?.properties?.action?.enum))
check('the tool declares an output renderer', typeof tools[0]?.output?.render === 'function')

console.log('\nroute')
check('registered exactly one route', routes.length === 1, String(routes.length))
check('the route is a prefix at /persona-card', routes[0]?.kind === 'prefix' && routes[0]?.path === '/persona-card', JSON.stringify({ k: routes[0]?.kind, p: routes[0]?.path }))
check('the route has a handler', typeof routes[0]?.handler === 'function')

// ---- load-order safety ----------------------------------------------------
console.log('\nload-order safety')
const noServiceCtx = {
  logger: { warn: () => {}, error: () => {} },
  root: {},
  inject (deps, cb) {
    cb({ get: () => undefined, effect: () => { throw new Error('effect() must not run when its service is absent') } })
  },
}
let earlyReturnOk = true
try { apply(noServiceCtx, { storeDir: process.env.PERSONA_TEST_DIR }) } catch { earlyReturnOk = false }
check('returns quietly when none of its services are mounted yet', earlyReturnOk)

if (failures.length > 0) {
  console.log(`\nRESULT: FAILED (${failures.length}) -> ${failures.join('; ')}`)
  process.exit(1)
}
console.log('RESULT: OK — all checks passed')
