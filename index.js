/**
 * dsh-companion — Host half.
 *
 * Registers ONE system-prompt section through the official `systemPrompt`
 * service, plus one model tool that reads/writes THIS session's override.
 *
 * Load-order note: both `ctx.inject(...)` calls are deliberate, not stylistic.
 * A plugin row may be applied BEFORE the `systemPrompt` / `tools` services
 * exist; an eager `ctx.get` would then see `undefined` and skip registration
 * silently and permanently. `ctx.inject` re-runs the callback whenever a
 * required service appears, so registration survives any load order. This
 * mirrors dsh-todo-board's proven pattern.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CardStore, defaultStoreDir, dshHome, normaliseAssets } from './lib/cards.mjs'
import { SessionOverrides, resolveCard } from './lib/sessions.mjs'
import { makeRefusal, readJsonBody, sendJson } from './lib/http.mjs'
import { syncCard } from './lib/whale.mjs'
import { readLedger, summarise, readTimeline, attributeEvents, recordActiveCard } from './lib/usage.mjs'
import { BillingSplit } from './lib/billing.mjs'
import { MultiplierResolver } from './lib/multiplier.mjs'
import { MemoryStore, renderMemory } from './lib/memory.mjs'

/** Stable section name. */
const SECTION_NAME = 'persona-card'

/**
 * Placement. The deployment persona prefix owns order 0 and first-party policy
 * sections start at 500, so 150 lands the card right after the deployment
 * persona and before tool guidance.
 */
const SECTION_ORDER = 150

/** The memory-recording rules, in their own section (see the registration). */
const MEMORY_RULES_SECTION = 'persona-card:memory-rules'

/** Delay before the one-shot startup backup, to avoid racing harness startup. */
const MEMORY_STARTUP_BACKUP_DELAY_MS = 30 * 1000

/** Snapshots kept per card (pruned oldest-first). */
const MEMORY_BACKUP_KEEP = 30

/**
 * Placement for the rules: just after the card (150), well before policy at 500.
 *
 * Deliberately adjacent to the card rather than at the very end: the rules only
 * make sense while reading the persona, and a rule paragraph thousands of tokens
 * later is a rule the model has already stopped attending to.
 */
const MEMORY_RULES_ORDER = 160

/**
 * Render the memory-recording rules.
 *
 * Returns '' when no card is active, so an install without a persona adds
 * nothing at all rather than nagging every session about a feature it is not
 * using.
 *
 * These rules answer the one question the model otherwise gets wrong every turn:
 * "is this worth remembering?" Without them every tool call becomes a memory,
 * and the noise then displaces the things that actually mattered.
 *
 * @param {boolean} hasCard
 * @returns {string}
 */
export function renderMemoryRules (hasCard) {
  if (hasCard !== true) return ''
  return [
    '## 记忆的记法',
    '你有一份跨会话保留的长期记忆（用 `' + TOOL_NAME + '` 工具的 `remember` / `recall` 读写）。',
    '',
    '**该记的**（这些才是「这个人在意什么」的证据）：',
    '- 工作之外的闲聊、玩笑、互相调侃',
    '- 明显的情绪：开心、委屈、生气、被戳到',
    '- 反复提到的偏好、习惯、讨厌的东西',
    '- 有分量的节点：第一次见面、某件事办成了、闹别扭又和好',
    '',
    '**不该记的**（记了会让记忆变流水账，把真正重要的挤掉）：',
    '- 任务执行过程（读了哪个文件、跑了什么测试、改了几行代码）',
    '- 一句话就能重新问清的技术细节',
    '- 已经记过的事，换个说法再说一遍',
    '',
    '**怎么写**：`summary` 一句话摘要、不超过 60 字、**不抄原话**；`feeling` 写你当时的感受。',
    '一次对话里值得记的通常只有几件，不是每轮都要记。**没东西可记就不记。**',
    '',
    '**好感度**是角色内部刻度（0-100），用来保持人设连贯，**不是对真实关系的度量**。',
    '只在明显该动时动，一次一两点就够；不要因为对方客气就猛涨。',
  ].join('\n')
}

const TOOL_NAME = 'persona_card'
const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * Default off-directory backup location for persona memories.
 *
 * Deliberately OUTSIDE `$DSH_HOME`: the whole point is to survive the persona-card
 * store (or the drive it sits on) disappearing. Living under the workspace keeps
 * it on the same machine but in a different tree, so deleting the store by
 * accident cannot reach it.
 */
const DEFAULT_MEMORY_BACKUP_DIR = path.resolve(HERE, '..', '..', 'persona-memory-backups')

/** Local timestamp, `YYYY-MM-DDTHH:mm:ss`. */
function stamp () {
  const t = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`
}

/**
 * Render the section body for one resolved card.
 *
 * Returns '' so an unconfigured or opted-out session contributes nothing at all
 * — the system-prompt package drops empty sections before rendering, so there
 * is no stray header left in the prompt.
 *
 * @param {object | undefined} card
 * @param {string} [memoryText] - the rendered memory block, or '' for none.
 * @returns {string}
 */
export function renderCard (card, memoryText = '') {
  if (card === undefined) return ''
  const lines = [
    `## 人设卡：${card.name}`,
    '以下角色设定由「人设卡」插件在本会话中生效；请严格按其中的身份、语气与行为准则回应。',
    '',
    card.systemPrompt.trim(),
  ]
  if (typeof card.trigger === 'string' && card.trigger.trim() !== '') {
    lines.push('', `【解除本设定】${card.trigger.trim()}`)
  }
  // Memory goes last so the persona text stays a stable prefix (prompt caching)
  // and the part that changes between sessions sits at the end.
  if (typeof memoryText === 'string' && memoryText !== '') lines.push(memoryText)
  return lines.join('\n')
}

/** Tool input schema (plain JSON Schema, per the tool registry contract). */
const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['status', 'on', 'off', 'clear', 'use', 'list', 'create', 'sync', 'usage', 'remember', 'recall', 'restore', 'mood', 'affinity'],
      description:
        'status=查看本会话当前生效的人设；on=为本会话开启（跟随全局选中的卡）；off=为本会话关闭人设（其它会话不受影响）；' +
        'use=为本会话指定某张卡；clear=清除本会话的设置；list=列出所有人设卡；' +
        'create=新建或更新一张卡；sync=把卡上绑定的角色图/音效/泡泡图同步进鲸鱼挂件；' +
        'usage=查看白饭账本（今日/近7天/累计）与按人设卡的消耗归因；' +
        'remember=给当前人设卡记一条「任务之外」的回忆（聊天的、有情绪的）；recall=读出这份记忆（文件丢失或损坏时会明确告警）；' +
        'restore=从 .bak 备份恢复记忆（仅当主文件丢失或损坏时用）；' +
        'mood=更新角色当前心情；affinity=手动调整好感度（仅在用户明确要求时用）。',
    },
    cardId: { type: 'string', description: 'action=use 或 sync 时的卡片 id；create 时可省略（由 name 派生）；记忆类动作省略则用当前生效卡。' },
    name: { type: 'string', description: 'action=create 时的卡片显示名。' },
    systemPrompt: { type: 'string', description: 'action=create 时的人设正文（角色设定全文）。' },
    trigger: { type: 'string', description: 'action=create 时的解除设定触发词，例如「切回普通模式」。' },
    note: { type: 'string', description: 'action=create 时的备注。' },
    kind: {
      type: 'string',
      enum: ['chat', 'emotion', 'trait', 'milestone'],
      description: 'action=remember 时的回忆类型：chat=闲聊、emotion=情绪事件、trait=性格成形、milestone=重要节点。默认 chat。',
    },
    summary: { type: 'string', description: 'action=remember 时的一句话摘要（60 字以内，不抄原话）。' },
    feeling: { type: 'string', description: 'action=remember 时角色当时的感受（一句话）。' },
    mood: { type: 'string', description: 'action=mood 时的新心情（一句话）。' },
    traits: {
      type: 'array',
      items: { type: 'string' },
      description: 'action=remember 时顺带沉淀的性格关键词（会去重累积）。',
    },
    delta: { type: 'number', description: 'action=affinity 时的增量（例如 +2 / -3），结果会夹在 0-100。' },
    value: { type: 'number', description: 'action=affinity 时直接设定好感度数值（0-100），优先于 delta。' },
    assets: {
      type: 'object',
      description:
        'action=create/sync 时绑定的资源，值为本机绝对路径。可用键：roleImage（角色图 png/gif）、pressSound / releaseSound（音效 wav）、bubbleImage（泡泡图 png/gif）。',
      properties: {
        roleImage: { type: 'string' },
        pressSound: { type: 'string' },
        releaseSound: { type: 'string' },
        bubbleImage: { type: 'string' },
      },
      additionalProperties: false,
    },
    makeActive: { type: 'boolean', description: 'action=create 时是否顺便把这张卡设为全局生效。默认否。' },
  },
  required: ['action'],
  additionalProperties: false,
}

/** Derive a card id from a display name when the caller does not supply one. */
function idFromName (name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  // A purely non-ASCII name (the common case here) slugifies to nothing, so fall
  // back to a timestamp-suffixed name rather than refusing to create the card.
  return base === '' ? `card-${Date.now().toString(36)}` : base
}

/**
 * Host plugin entry.
 *
 * @param {object} ctx
 * @param {object} [config]
 */
export function apply (ctx, config = {}) {
  const storeDir = typeof config.storeDir === 'string' && config.storeDir.trim() !== ''
    ? config.storeDir
    : defaultStoreDir()
  const store = new CardStore(storeDir)
  const overrides = new SessionOverrides(storeDir)
  const memories = new MemoryStore(storeDir)

  /** Where the auto-backup copies go. Overridable via config for tests. */
  const memoryBackupDir = typeof config.memoryBackupDir === 'string' && config.memoryBackupDir.trim() !== ''
    ? config.memoryBackupDir
    : DEFAULT_MEMORY_BACKUP_DIR

  // Credit multipliers: config overrides win, otherwise the live WorkBuddy route
  // is consulted on a TTL. Deliberately non-blocking — a cold cache reports
  // "unknown" rather than stalling a turn on a network read.
  //
  // The origin comes from `ctx.webServer.getOrigin()`, NOT from `DSH_WEB_URL`.
  // That distinction cost two rounds of debugging: the variable is exported to
  // the model's SHELL process, so it is visible to a `pwsh` call but absent from
  // the plugin HOST process — which is precisely where this code runs. Reading
  // the environment worked in my tests (a shell) and failed in production (the
  // host). The webServer service knows the port it actually bound, including an
  // OS-assigned one, so it is the correct source.
  //
  // `webServer` may not be mounted yet when this row loads, so the getter is
  // resolved lazily on every refresh instead of captured here.
  const multipliers = new MultiplierResolver({
    overrides: config.creditMultipliers,
    env: config.env,
    originFn: () => {
      try {
        const webServer = ctx.get?.('webServer')
        if (webServer !== undefined && typeof webServer.getOrigin === 'function') {
          return webServer.getOrigin()
        }
      } catch {
        /* not mounted yet, or getOrigin() threw before the port was bound */
      }
      return undefined
    },
    log: (m) => ctx.logger?.warn?.(`dsh-companion: ${m}`),
  })

  // Live per-session billing accumulators, fed from the session event stream.
  // Kept in memory only: the durable account of what was spent is the session
  // log itself, which remains the source of truth (`session/*` events are
  // appended by the harness, not by us — see the practices doc on not inventing
  // event types).
  const liveBilling = new Map()

  // One accumulator for the WHOLE process, spanning every session.
  //
  // Why both: a per-session number resets whenever the user opens a new chat,
  // which reads as "the counter is broken" rather than "this is a fresh chat".
  // The headline figure the panel shows is therefore the process total — "how
  // much have I spent since I launched the app" — and the per-session map is
  // kept alongside it for the per-session breakdown.
  //
  // There is deliberately no persistence: the process total resetting on relaunch
  // is the requested behaviour ("what did I use since I opened this"), not an
  // oversight.
  const processBilling = new BillingSplit()

  /**
   * Record one step's cost into the right ledger, by provider.
   *
   * This is the whole point of the split: the whale prices every turn from the
   * DeepSeek money table because it only reads `source.model`; reading
   * `source.provider` is what tells credits from money.
   *
   * @param {string} sessionId
   * @param {any} event
   */
  function noteBilling (sessionId, event) {
    try {
      if (event?.type !== 'assistant/message') return
      const d = event.data
      if (d === null || typeof d !== 'object' || d.usage === null || typeof d.usage !== 'object') return

      const step = {
        source: d.message?.source,
        usage: d.usage,
        multiplierFor: (model) => multipliers.lookup(model),
        // Pass the event's own time so a money-funded step is priced at the
        // rate that applied then (peak hours are double).
        atMs: Number.isFinite(event.time) ? event.time : Date.now(),
      }

      let agg = liveBilling.get(sessionId)
      if (agg === undefined) {
        agg = new BillingSplit()
        liveBilling.set(sessionId, agg)
      }
      agg.add(step)
      // The same step also feeds the process-wide total, so the headline figure
      // survives switching chats.
      processBilling.add(step)

      // Keep the multiplier table warm so the amount stays resolvable.
      if (!multipliers.fresh) void multipliers.refresh()
    } catch {
      // Billing must never break a turn.
    }
  }

  /**
   * Resolve which card one assembly should inject. `context.agent` is the
   * official assembly context (see dsh-system-prompt `assemble()`), so this runs
   * per session rather than once at load.
   *
   * @param {any} context
   */
  function resolveFor (context) {
    const sessionId = context?.agent?.session?.id
    const override = typeof sessionId === 'string' ? overrides.get(sessionId) : undefined
    return resolveCard(override, store.activeCard(), (id) => store.get(id))
  }

  /** One-line description of the current state, for the tool. */
  function describe (context) {
    const r = resolveFor(context)
    const global = store.activeCard()
    const g = global === undefined ? '无' : global.id
    if (r.card !== undefined) return `本会话生效：${r.card.name}（${r.card.id}）｜来源 ${r.reason}｜全局选中 ${g}`
    const why = {
      'session-disabled': '本会话已关闭人设注入',
      'session-card-missing': `本会话指定的卡不存在：${r.wanted ?? '?'}`,
      'no-global-card': '全局没有选中任何卡',
    }[r.reason] ?? r.reason
    return `本会话不注入人设：${why}｜全局选中 ${g}`
  }

  // -------------------------------------------------- live billing stream
  //
  // `session/event` is how the whale widget itself observes each step's usage
  // (verified in its source). We read the SAME event and the same `usage` shape,
  // plus `message.source.provider` — the field the widget ignores, and the one
  // that decides whether a turn was paid in credits or in money.
  try {
    ctx.effect(() => {
      const off = ctx.on('session/event', (session, event) => {
        const sid = session?.id
        if (typeof sid !== 'string' || sid === '') return
        noteBilling(sid, event)
      })
      const offDisposed = ctx.on('session/disposed', (session) => {
        if (typeof session?.id === 'string') liveBilling.delete(session.id)
      })
      return () => {
        try { off?.() } catch {}
        try { offDisposed?.() } catch {}
      }
    }, 'dsh-companion: billing stream')
  } catch (err) {
    ctx.logger?.warn?.(`dsh-companion: 无法订阅计费事件：${String(err?.message ?? err)}`)
  }

  // ------------------------------------------------------ memory auto-backup
  //
  // Primary protection: backup-on-change. Every `remember` / `mood` / `affinity`
  // write also snapshots to an off-directory location, so a memory that changed
  // is a memory that got backed up — it does not depend on the harness staying
  // open or on a timer firing.
  //
  // This startup sweep is only a BACKSTOP: it catches memories that were written
  // while a previous run was torn down mid-write, or whose off-dir copy failed
  // for a transient reason. It is deliberately delayed (not first-tick) so it
  // does not race the harness's own startup work.
  //
  // There is deliberately NO setInterval here. A timer only runs while DSH is
  // open, which is exactly when a "every 6 hours" backup is least likely to be
  // needed, and `unref()` means it may never fire at all. Change-triggered
  // backup has none of those failure modes.
  try {
    ctx.effect(() => {
      const timer = setTimeout(() => {
        try {
          const r = memories.backupTo(memoryBackupDir, { keep: MEMORY_BACKUP_KEEP })
          if (!r.ok) ctx.logger?.warn?.(`dsh-companion: 启动补备份失败：${r.problem}`)
        } catch (err) {
          ctx.logger?.warn?.(`dsh-companion: 启动补备份异常：${String(err?.message ?? err)}`)
        }
      }, MEMORY_STARTUP_BACKUP_DELAY_MS)
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearTimeout(timer)
    }, 'dsh-companion: memory startup backup')
  } catch (err) {
    ctx.logger?.warn?.(`dsh-companion: 无法安排启动补备份：${String(err?.message ?? err)}`)
  }

  // ------------------------------------------------------- prompt section
  ctx.inject(['systemPrompt'], (promptCtx) => {
    const prompt = promptCtx.get('systemPrompt')
    if (prompt === undefined) return

    promptCtx.effect(
      () =>
        prompt.section({
          name: SECTION_NAME,
          order: SECTION_ORDER,
          // A function, not a string: DSH re-resolves it on every assembly, so
          // switching cards or toggling a session takes effect without a reload.
          text: (context) => {
            const resolved = resolveFor(context)
            // Record which card this turn used, so the ledger's per-turn costs
            // can later be attributed to cards. This is the ONLY source of card
            // attribution — the whale's ledger has no such field. Cheap, and
            // swallows its own errors: failing to record must not break a prompt.
            recordActiveCard(storeDir, {
              at: Date.now(),
              cardId: resolved.card?.id ?? '',
              sessionId: context?.agent?.session?.id ?? '',
            })
            // Memory is read fresh on every assembly, not cached at load, so a
            // chapter written mid-conversation shows up on the very next step.
            const memoryText = resolved.card === undefined
              ? ''
              : renderMemory(memories.read(resolved.card.id))
            return renderCard(resolved.card, memoryText)
          },
        }),
      'dsh-companion: prompt section',
    )

    // The memory RULES ride in their own section, right after the card.
    //
    // Separate from the card body on purpose: the card text is the persona
    // (stable, user-authored), while this is operational instruction that
    // changes when the feature changes. Keeping them apart means editing the
    // rules never touches a user's persona text, and the persona stays a stable
    // prompt prefix for caching.
    //
    // Without these rules the model records everything — every file read, every
    // test run — and the memory becomes a log of nothing. The rules are the
    // whole reason the feature is worth having.
    promptCtx.effect(
      () =>
        prompt.section({
          name: MEMORY_RULES_SECTION,
          order: MEMORY_RULES_ORDER,
          text: (context) => renderMemoryRules(resolveFor(context).card !== undefined),
        }),
      'dsh-companion: memory rules',
    )
  })

  // ----------------------------------------------------------- model tool
  ctx.inject(['tools'], (toolsCtx) => {
    const tools = toolsCtx.get('tools')
    if (tools === undefined) return

    const definition = {
      name: TOOL_NAME,
      description:
        '人设卡：查看或调整「本会话」的人设注入。人设卡由 dsh-companion 插件注入到系统提示里。' +
        'action=status 查看本会话当前生效的卡与来源；action=off 让本会话不再注入人设（其它会话不受影响）；' +
        'action=on 恢复跟随全局选中的卡；action=use 用 cardId 为本会话指定一张卡；action=clear 清除本会话的设置。' +
        '写操作立即生效，不需要重启。',
      parameters: TOOL_PARAMETERS,
      output: {
        schema: {
          type: 'object',
          properties: {
            message: { type: 'string' },
            status: { type: 'string' },
            activeCardId: { type: 'string' },
            enabled: { type: 'boolean' },
          },
          required: ['message'],
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      execute: async (args, exec) => {
        const input = args !== null && typeof args === 'object' ? args : {}
        const action = typeof input.action === 'string' ? input.action : 'status'
        const sessionId = exec?.agent?.session?.id

        if (action === 'status') {
          return { message: describe(exec), status: 'ok', activeCardId: resolveFor(exec).card?.id ?? '' }
        }

        // These three do not need a session: they act on the card library as a
        // whole. They therefore sit BEFORE the session check, which would
        // otherwise refuse them in a context that cannot name a session.
        if (action === 'list') {
          const cards = store.list()
          if (cards.length === 0) return { message: '还没有任何人设卡。', status: 'ok' }
          const active = store.getActiveId()
          const lines = cards.map((c) => {
            const bound = Object.keys(c.assets ?? {})
            return `- ${c.id}（${c.name}）${c.id === active ? ' ← 全局生效' : ''}${bound.length === 0 ? '' : ` ｜ 绑定资源 ${bound.join(', ')}`}`
          })
          return { message: `共 ${cards.length} 张人设卡：\n${lines.join('\n')}`, status: 'ok' }
        }

        if (action === 'create') {
          const name = typeof input.name === 'string' ? input.name.trim() : ''
          const systemPrompt = typeof input.systemPrompt === 'string' ? input.systemPrompt : ''
          if (name === '') return { message: 'action=create 需要提供 name。', status: 'error' }
          if (systemPrompt.trim() === '') return { message: 'action=create 需要提供 systemPrompt（人设正文）。', status: 'error' }

          const wantedId = typeof input.cardId === 'string' && input.cardId.trim() !== ''
            ? input.cardId.trim()
            : idFromName(name)

          const card = {
            id: wantedId,
            name,
            systemPrompt,
            createdAt: stamp(),
          }
          if (typeof input.trigger === 'string' && input.trigger.trim() !== '') card.trigger = input.trigger.trim()
          if (typeof input.note === 'string' && input.note.trim() !== '') card.note = input.note.trim()
          const assets = normaliseAssets(input.assets)
          if (!assets.ok) return { message: `资源绑定有问题：${assets.problem}`, status: 'error' }
          card.assets = assets.assets

          const r = store.upsert(card)
          if (!r.ok) return { message: `保存失败：${r.problem}`, status: 'error' }

          const lines = [`已${r.replaced ? '更新' : '新建'}人设卡：${card.name}（${card.id}）`]
          const boundKeys = Object.keys(assets.assets)
          if (boundKeys.length > 0) {
            // Sync the assets in the same call: the user asked for one thing, and
            // a card whose picture never reached the whale would look broken.
            const sync = syncCard({ home: dshHome(), card })
            const failed = sync.results.filter((x) => x.ok !== true)
            lines.push(failed.length === 0
              ? `已把 ${boundKeys.length} 个绑定资源同步进鲸鱼挂件。`
              : `资源同步有失败：${failed.map((f) => `${f.key}（${f.problem}）`).join('；')}`)
          }
          if (input.makeActive === true) {
            const set = store.setActiveId(card.id)
            if (set.ok) lines.push('已设为全局生效。')
            else lines.push(`设为全局生效失败：${set.problem}`)
          }
          return { message: lines.join('\n'), status: 'create', activeCardId: card.id }
        }

        if (action === 'sync') {
          const wanted = typeof input.cardId === 'string' && input.cardId.trim() !== ''
            ? input.cardId.trim()
            : store.getActiveId()
          if (wanted === undefined || wanted === '') {
            return { message: '没有指定卡片，且全局也没有选中任何卡。', status: 'error' }
          }
          const card = store.get(wanted)
          if (card === undefined) return { message: `没有这张卡：${wanted}`, status: 'error' }
          const bound = Object.keys(card.assets ?? {})
          if (bound.length === 0) return { message: `「${card.name}」没有绑定任何资源，无需同步。`, status: 'sync' }

          const sync = syncCard({ home: dshHome(), card })
          const lines = sync.results.map((x) => x.ok === true
            ? `✓ ${x.key} → ${x.kind}${x.skipped === true ? '（内容相同，已跳过复制）' : ''}`
            : `✗ ${x.key}：${x.problem}`)
          lines.push(sync.ok ? '同步完成。' : '部分资源同步失败。')
          return { message: lines.join('\n'), status: sync.ok ? 'sync' : 'error' }
        }

        if (action === 'usage') {
          const lines = []

          // ---- 1. the two ledgers, split by provider ------------------------
          // This is the part that finally answers "credit or my own money?".
          // The headline is the PROCESS total ("since I launched the app"); the
          // current chat's share follows when it is a smaller subset, because a
          // per-chat-only figure reads as 0 in every fresh chat.
          void multipliers.refresh()
          const processJson = processBilling.toJSON()
          const live = typeof sessionId === 'string' ? liveBilling.get(sessionId) : undefined
          const liveJson = live === undefined ? undefined : live.toJSON()

          lines.push('【两本账 · 自本次启动累计】')
          if (processJson.credits.steps + processJson.money.steps + processJson.unknown.steps === 0) {
            lines.push('自本次启动以来还没有记录到任何模型步骤（本插件通过会话事件流逐轮记账）。')
          } else {
            const c = processJson.credits
            const m = processJson.money
            const u = processJson.unknown

            if (c.steps > 0) {
              const amount = c.complete
                ? `${c.amount.toFixed(2)} 积分`
                : `至少 ${c.amount.toFixed(2)} 积分（有模型的倍率未知，实际会更多）`
              lines.push(`· 积分消耗：${amount} — ${c.steps} 步，${c.tokens.toLocaleString()} tokens`)
              lines.push(`  走积分的模型：${c.models.join(', ') || '(未记录)'}`)
              // State the multiplier actually used. Without this the user cannot
              // tell "looked up fine" from "quietly fell back to 0".
              const table = multipliers.table()
              const used = c.models
                .map((m) => (Number.isFinite(table[m]) ? `${m} ×${table[m]}` : null))
                .filter(Boolean)
              if (used.length > 0) {
                lines.push(`  倍率（实时取自 workbuddy）：${used.join('、')}`)
              } else if (!multipliers.fresh) {
                lines.push(`  倍率：尚未取到（${multipliers.lastProblem ?? '正在查询'}）`)
              }
            }

            if (m.steps > 0) {
              lines.push(`· Token 直接扣费：¥${m.amount.toFixed(4)} — ${m.steps} 步，${m.tokens.toLocaleString()} tokens`)
              lines.push(`  走余额的模型：${m.models.join(', ') || '(未记录)'}`)
            }

            if (u.steps > 0) {
              lines.push(`· 未识别 provider：${u.steps} 步，${u.tokens.toLocaleString()} tokens（${u.providers.join(', ') || '未知'}）— 不并入上面任何一本账`)
            }

            // This chat's own share, only when it is a genuine subset.
            if (liveJson !== undefined) {
              const cs = liveJson.credits
              const ms = liveJson.money
              if (cs.steps + ms.steps + liveJson.unknown.steps !== 0 &&
                  (cs.steps !== c.steps || ms.steps !== m.steps)) {
                const bits = []
                if (cs.steps > 0) bits.push(`${cs.amount.toFixed(2)} 积分`)
                if (ms.steps > 0) bits.push(`¥${ms.amount.toFixed(4)}`)
                lines.push(`  其中本对话：${bits.join(' + ')}（${cs.steps + ms.steps + liveJson.unknown.steps} 步）`)
              }
            }
          }

          // ---- 2. the whale's ledger, labelled for what it is --------------
          const ledger = readLedger()
          lines.push('', '【鲸鱼挂件账本】')
          if (!ledger.ok) {
            lines.push(ledger.problem)
          } else {
            const summary = summarise(ledger.ledger, { days: 7 })
            lines.push(`今日 ¥${summary.today.yuan} · 近 7 天 ¥${summary.window.yuan} · 累计 ¥${summary.lifetime.yuan}（币种 ${summary.currency}）`)
            lines.push(`逐轮记录 ¥${summary.eventLog.yuan}（${summary.eventLog.entries} 轮）`)
            lines.push('注：挂件只读 source.model、按 DeepSeek 人民币价目表估算，**不看 provider**。')
            lines.push('    所以积分服务的轮次也会被它贴上人民币标签 —— 那些 ¥ 不是你的真实花费。')
          }

          // ---- 3. per-card attribution, honest about its basis -------------
          if (ledger.ok) {
            const timeline = readTimeline(storeDir)
            const attribution = attributeEvents(ledger.ledger.events, timeline)
            lines.push('', '【按人设卡归因】')
            if (attribution.cards.length === 0) {
              lines.push('还没有可归因的观测记录（插件在每次注入人设时记录当时的生效卡；此前发生的消耗无法回溯归因）。')
            } else {
              for (const c of attribution.cards) {
                const card = store.get(c.id)
                lines.push(`· ${card === undefined ? c.id : card.name}（${c.id}）：¥${c.yuan}，${c.turns} 轮，${c.tokens} tokens`)
              }
              lines.push(`未归因：¥${attribution.unattributed.yuan}（插件未运行期间，或当时未启用任何人设）`)
              lines.push(`覆盖率：${(attribution.coverage * 100).toFixed(1)}%`)
              lines.push('注：这是按挂件那套人民币估价归因的，**不是积分**。')
            }
          }

          // ---- 4. the one paragraph that keeps the units straight ----------
          lines.push(
            '',
            '【口径说明】',
            '· 积分与人民币是两笔独立的账，本插件不把它们相加（相加会得到一个没有单位的数）。',
            '· 积分公式：tokens ÷ 1,000,000 × 模型倍率。倍率来自 workbuddy 的实时接口，与配置里那份可能不同（配置里的目录会过期）。',
            '· 倍率未知的模型不会被当成 0 —— 那会把「不知道」伪装成「免费」。',
            '· 账本口径与逐轮口径本就不同（账本只累计观测到的余额下降），这里两个都摆出来。',
          )
          return { message: lines.join('\n'), status: 'usage' }
        }

        // ------------------------------------------------ persona memory
        //
        // These four act on the CARD, not on a session, so they sit before the
        // session guard below. The card is whichever one this session resolved
        // to, unless an explicit cardId names another.
        if (action === 'remember' || action === 'recall' || action === 'restore' || action === 'mood' || action === 'affinity') {
          const wanted = typeof input.cardId === 'string' && input.cardId.trim() !== ''
            ? input.cardId.trim()
            : resolveFor(exec).card?.id
          if (typeof wanted !== 'string' || wanted === '') {
            return { message: '本会话没有生效的人设卡，记忆类操作无处可记。先用 action=use 指定一张，或用 cardId 参数点名。', status: 'error' }
          }
          const card = store.get(wanted)
          if (card === undefined) {
            return { message: `没有这张卡：${wanted}`, status: 'error' }
          }

          if (action === 'recall') {
            // inspect() rather than read(), so a deleted or corrupted file is
            // REPORTED instead of silently reading as "never talked". A memory
            // that vanishes without a word is worse than one that errors loudly.
            const info = memories.inspect(wanted)
            const m = info.memory
            const block = renderMemory(m)
            const head = `【${card.name} 的记忆】好感 ${m.affinity}/100 · 心情 ${m.mood === '' ? '(未设)' : m.mood} · 性格 ${m.traits.length === 0 ? '(未沉淀)' : m.traits.join('、')} · 共 ${m.chapters.length} 条`

            const warnings = []
            if (info.state === 'corrupt') warnings.push('⚠️ 记忆文件在磁盘上但读不出来（可能被写坏了）。')
            else if (info.state === 'missing' && info.hasBackup) warnings.push('⚠️ 记忆文件不见了，但备份还在。')
            if (warnings.length > 0 && info.hasBackup) {
              warnings.push(`备份里有 ${info.backupChapters} 条。要恢复就说「恢复记忆」，用 action=restore。`)
            }

            const body = block === '' ? '（还没有任何记忆 —— 只有任务之外的闲聊、情绪才会被记下来。）' : block
            return {
              message: warnings.length > 0 ? `${head}\n${warnings.join('\n')}\n${body}` : `${head}\n${body}`,
              status: 'recall',
            }
          }

          if (action === 'restore') {
            const r = memories.restore(wanted)
            if (!r.ok) return { message: `恢复失败：${r.problem}`, status: 'error' }
            return {
              message: `已从备份恢复「${card.name}」的记忆：${r.memory.chapters.length} 条，好感 ${r.memory.affinity}/100。`,
              status: 'restore',
            }
          }

          if (action === 'remember') {
            const summary = typeof input.summary === 'string' ? input.summary.trim() : ''
            if (summary === '') return { message: 'action=remember 需要提供 summary（一句话摘要）。', status: 'error' }
            const chapter = { at: new Date().toISOString(), summary }
            if (typeof input.kind === 'string' && input.kind !== '') chapter.kind = input.kind
            if (typeof input.feeling === 'string' && input.feeling.trim() !== '') chapter.feeling = input.feeling.trim()

            const patch = { chapters: [chapter] }
            if (Array.isArray(input.traits) && input.traits.length > 0) patch.traits = input.traits
            if (Number.isFinite(input.delta) && input.delta !== 0) patch.affinityDelta = input.delta
            patch.lastSeen = new Date().toISOString()

            const r = await memories.updateAndBackup(wanted, patch, memoryBackupDir)
            if (!r.ok) return { message: `记忆写入失败：${r.problem}`, status: 'error' }
            const m = r.memory
            const bak = r.backedUp === true ? ' · 已同步外部备份' : (r.backupProblem !== undefined ? ` · ⚠️外部备份失败：${r.backupProblem}` : '')
            return {
              message: `已记下一笔（${card.name}）：${chapter.summary}\n现在共 ${m.chapters.length} 条 · 好感 ${m.affinity}/100${Array.isArray(patch.traits) ? ` · 性格 +${patch.traits.length}` : ''}${bak}`,
              status: 'remember',
            }
          }

          if (action === 'mood') {
            const mood = typeof input.mood === 'string' ? input.mood.trim() : ''
            if (mood === '') return { message: 'action=mood 需要提供 mood（一句话心情）。', status: 'error' }
            const r = await memories.updateAndBackup(wanted, { mood, lastSeen: new Date().toISOString() }, memoryBackupDir)
            if (!r.ok) return { message: `心情写入失败：${r.problem}`, status: 'error' }
            return { message: `（${card.name}）现在的心情：${mood}`, status: 'mood' }
          }

          // affinity
          const patch = { lastSeen: new Date().toISOString() }
          if (Number.isFinite(input.value)) patch.affinity = input.value
          else if (Number.isFinite(input.delta)) patch.affinityDelta = input.delta
          else return { message: 'action=affinity 需要提供 delta（增量）或 value（绝对值）。', status: 'error' }
          const before = memories.read(wanted).affinity
          const r = await memories.updateAndBackup(wanted, patch, memoryBackupDir)
          if (!r.ok) return { message: `好感写入失败：${r.problem}`, status: 'error' }
          const after = r.memory.affinity
          const sign = after > before ? `+${after - before}` : String(after - before)
          return { message: `（${card.name}）好感度：${before} → ${after}（${sign}），范围 0-100。`, status: 'affinity' }
        }

        if (typeof sessionId !== 'string' || sessionId === '') {
          return { message: '拿不到当前会话 id，操作未执行。', status: 'error' }
        }

        if (action === 'off') {
          const r = overrides.set(sessionId, { enabled: false })
          if (!r.ok) return { message: `关闭失败：${r.problem}`, status: 'error' }
          return { message: `已为本会话关闭人设注入，其它会话不受影响。\n${describe(exec)}`, status: 'off', enabled: false }
        }

        if (action === 'on') {
          const r = overrides.set(sessionId, { enabled: true })
          if (!r.ok) return { message: `开启失败：${r.problem}`, status: 'error' }
          return { message: `本会话已恢复跟随全局选中的卡。\n${describe(exec)}`, status: 'on', enabled: true }
        }

        if (action === 'use') {
          const wanted = typeof input.cardId === 'string' ? input.cardId.trim() : ''
          if (wanted === '') return { message: 'action=use 需要提供 cardId。', status: 'error' }
          if (store.get(wanted) === undefined) {
            const known = store.list().map((c) => c.id).join(', ') || '(无)'
            return { message: `没有这张卡：${wanted}。可用的卡：${known}`, status: 'error' }
          }
          const r = overrides.set(sessionId, { enabled: true, cardId: wanted })
          if (!r.ok) return { message: `设置失败：${r.problem}`, status: 'error' }
          return { message: `本会话已改用指定卡。\n${describe(exec)}`, status: 'use', activeCardId: wanted, enabled: true }
        }

        if (action === 'clear') {
          const r = overrides.clear(sessionId)
          return { message: `已清除本会话的设置（${r}）。\n${describe(exec)}`, status: 'clear' }
        }

        return { message: `未知 action：${action}`, status: 'error' }
      },
    }

    toolsCtx.effect(() => tools.register(definition), 'dsh-companion: persona_card tool')
  })

  // --------------------------------------------------------------- routes
  //
  // The panel reads state and writes the global selection through these routes.
  // Every request passes the trust fence FIRST (see lib/http.mjs for why that
  // matters: without it, a shell-equipped model could bypass the approval gate
  // entirely). Reads and writes share one route pair so the panel has a single
  // transport.
  ctx.inject(['webServer'], (hostCtx) => {
    const server = hostCtx.get('webServer')
    if (server === undefined) return

    // Both contexts are passed on purpose: if the injected host context cannot
    // see the `connection` service, the plugin's own context still supplies the
    // real harness gate. Degrading silently to the weaker local fence is the one
    // failure this must not have.
    const refuse = makeRefusal([hostCtx, ctx], (level, message) => {
      try {
        if (level === 'error') hostCtx.logger?.error?.(message)
        else hostCtx.logger?.warn?.(message)
      } catch {
        /* logging must never break a request */
      }
    })

    /** Everything the panel needs, in one payload. */
    const snapshot = (sessionId) => {
      const globalCard = store.activeCard()
      const override = typeof sessionId === 'string' ? overrides.get(sessionId) : undefined
      const resolved = resolveCard(override, globalCard, (id) => store.get(id))
      return {
        cards: store.list().map((c) => ({ id: c.id, name: c.name })),
        activeCardId: globalCard?.id ?? '',
        session: override === undefined ? { enabled: undefined } : { enabled: override.enabled },
        effectiveCard: resolved.card?.name,
        effectiveReason: resolved.reason,
        effectiveEnabled: resolved.card !== undefined,
        sessionId: typeof sessionId === 'string' ? sessionId : '',
        billing: billingPayload(sessionId),
        usage: usagePayload(),
        // The panel also shows the persona's memory, so it is visible rather than
        // living only inside the prompt. Read from the ACTIVE card (the same one
        // the prompt uses), not a hard-coded id.
        memory: resolved.card === undefined ? undefined : memoryPayload(resolved.card.id),
      }
    }

    /**
     * The active card's memory, shaped for the panel.
     *
     * Uses inspect() so a missing or corrupt file is surfaced rather than reading
     * as "no memory". The panel is the place a human can SEE that, so it must not
     * silently degrade the way prompt assembly does.
     */
    const memoryPayload = (cardId) => {
      try {
        const info = memories.inspect(cardId)
        const m = info.memory
        const recent = m.chapters.slice(-3).map((c) => ({
          summary: c.summary,
          kind: c.kind,
          feeling: c.feeling,
        }))
        return {
          affinity: m.affinity,
          mood: m.mood,
          traits: m.traits,
          count: m.chapters.length,
          recent,
          state: info.state,
          hasBackup: info.hasBackup,
          backupChapters: info.backupChapters,
        }
      } catch (err) {
        return { problem: String(err?.message ?? err) }
      }
    }

    /**
     * The two ledgers for the panel, split by how each turn was paid for.
     *
     * This is the panel's answer to "am I spending credits or my own money?".
     * Credits and money are returned as separate fields and are never added
     * together — they are different units, and a combined figure would be
     * meaningless.
     *
     * The HEADLINE numbers are the process-wide totals, not this session's: the
     * panel answers "what have I used since I opened the app", and a per-session
     * figure would silently reset every time the user starts a new chat. The
     * current session's own share is returned alongside as `session`.
     *
     * `multiplierStatus` is reported alongside so a partial credit total is
     * visibly partial rather than looking like a small bill.
     */
    const billingPayload = (sessionId) => {
      try {
        // Trigger a refresh when the cache is stale, then read whatever the
        // class holds right now.
        //
        // `refresh()` is async and this payload is synchronous, so the FIRST
        // call after a launch reports the empty table and the value appears on a
        // later poll. That is deliberate — blocking a state read on a network
        // fetch would make the whole panel wait — but it is exactly why the
        // panel must say "正在查询" rather than "倍率表为空", which reads as a
        // permanent failure. The message below distinguishes the two.
        if (!multipliers.fresh) void multipliers.refresh()
        const table = multipliers.table()
        const multipliersKnown = Object.keys(table).length > 0

        // Which model is this session ACTUALLY using? Ask the agent, the way the
        // harness itself does (`agent.options.model`, see the prompt variables
        // registered in dsh-agent-loop).
        //
        // Reporting the first three entries of the table instead — the previous
        // behaviour when no step had landed yet — listed models the user never
        // touched (hy4-preview, hy3, hy3-x) and looked like nonsense. A panel that
        // shows unrelated data is worse than one that shows none.
        const current = (() => {
          try {
            const agents = ctx.get?.('agents')
            if (agents === undefined || typeof sessionId !== 'string' || sessionId === '') return undefined
            const agent = agents.get?.(sessionId)
            const model = agent?.options?.model
            const provider = agent?.options?.provider
            if (typeof model !== 'string' || model === '') return undefined
            return {
              model,
              provider: typeof provider === 'string' ? provider : '',
              multiplier: Number.isFinite(table[model]) ? table[model] : undefined,
            }
          } catch {
            return undefined
          }
        })()

        const multiplierStatus = multipliersKnown
          ? { ok: true, models: Object.keys(table).length, sample: table, current }
          : {
              ok: false,
              // Two very different situations share this branch; name them apart.
              loading: multipliers.lastProblem === undefined,
              problem: multipliers.lastProblem ?? '倍率表尚未取到（首次查询进行中，约 1 秒后自动刷新）',
              current,
            }

        /** Shape one accumulator for the wire. */
        const shape = (j) => ({
          steps: j.credits.steps + j.money.steps + j.unknown.steps,
          credits: {
            amount: Number(j.credits.amount.toFixed(4)),
            tokens: j.credits.tokens,
            steps: j.credits.steps,
            models: j.credits.models,
            // False means some step's multiplier was unknown, so the amount is a
            // floor. The panel must say so instead of presenting a floor as a bill.
            complete: j.credits.complete,
          },
          money: {
            amount: Number(j.money.amount.toFixed(4)),
            tokens: j.money.tokens,
            steps: j.money.steps,
            models: j.money.models,
          },
          unknown: { tokens: j.unknown.tokens, steps: j.unknown.steps, providers: j.unknown.providers },
        })

        // Since the process started: the headline figure.
        const total = shape(processBilling.toJSON())

        // This session's own share, when we can name the session.
        const live = typeof sessionId === 'string' && sessionId !== '' ? liveBilling.get(sessionId) : undefined
        const session = live === undefined ? undefined : shape(live.toJSON())

        return {
          ...total,
          scope: 'process',
          multiplierStatus,
          session,
          // Kept truthful: when nothing has been observed yet, say so rather
          // than letting an all-zero row look like a real measurement.
          note: total.steps === 0
            ? '自本次启动以来还没有记录到模型步骤（插件通过会话事件流逐轮记账）'
            : undefined,
        }
      } catch (err) {
        return { problem: String(err?.message ?? err) }
      }
    }

    /**
     * The ledger figures the panel shows.
     *
     * Read fresh on every request: the whale writes its ledger continuously, so a
     * cached copy would be stale within seconds. Failures come back as a
     * `problem` string rather than an empty object, so the panel can say WHY it
     * shows nothing instead of silently rendering zeros.
     */
    const usagePayload = () => {
      try {
        const ledger = readLedger()
        if (!ledger.ok) return { problem: ledger.problem }
        const summary = summarise(ledger.ledger, { days: 7 })
        const attribution = attributeEvents(ledger.ledger.events, readTimeline(storeDir))
        return {
          currency: summary.currency,
          // Accounting口径, matching what the whale widget itself shows.
          today: summary.today.yuan,
          todayTurns: summary.eventLog.todayTurns,
          week: summary.window.yuan,
          lifetime: summary.lifetime.yuan,
          // Event-log口径, shown separately because the two genuinely disagree.
          eventLog: { yuan: summary.eventLog.yuan, entries: summary.eventLog.entries },
          perCard: attribution.cards.map((c) => ({ id: c.id, name: store.get(c.id)?.name ?? c.id, yuan: c.yuan, turns: c.turns })),
          unattributed: attribution.unattributed.yuan,
          coverage: Number(attribution.coverage.toFixed(3)),
        }
      } catch (err) {
        return { problem: String(err?.message ?? err) }
      }
    }

    const ROUTE = '/persona-card'

    // GET /persona-card/state  -> the panel's payload
    // POST /persona-card/set   -> { action, cardId?, sessionId? }
    hostCtx.effect(
      () =>
        server.register({
          kind: 'prefix',
          path: ROUTE,
          handler: async (request, response) => {
            const url = new URL(request.url === undefined ? '/' : request.url, 'http://localhost')
            const pathname = url.pathname.replace(/\/+$/, '') || ROUTE

            if (refuse(request, response, pathname)) return

            try {
              if (pathname === `${ROUTE}/state`) {
                if (request.method !== 'GET') {
                  response.writeHead(405, { allow: 'GET' })
                  response.end()
                  return
                }
                // The panel names its session explicitly; the Host cannot infer
                // the browser's session from the request alone.
                const sessionId = url.searchParams.get('sessionId') ?? undefined
                sendJson(response, 200, snapshot(sessionId === null ? undefined : sessionId))
                return
              }

              if (pathname === `${ROUTE}/set`) {
                if (request.method !== 'POST') {
                  response.writeHead(405, { allow: 'POST' })
                  response.end()
                  return
                }
                const body = await readJsonBody(request)
                const action = typeof body.action === 'string' ? body.action : ''
                const sessionId = typeof body.sessionId === 'string' && body.sessionId !== ''
                  ? body.sessionId
                  : undefined

                if (action === 'setGlobal') {
                  const wanted = typeof body.cardId === 'string' && body.cardId !== '' ? body.cardId : undefined
                  const r = store.setActiveId(wanted)
                  if (!r.ok) return sendJson(response, 400, { problem: r.problem })
                  return sendJson(response, 200, snapshot(sessionId))
                }

                if (action === 'sessionOff' || action === 'sessionFollow' || action === 'sessionClear') {
                  if (sessionId === undefined) {
                    return sendJson(response, 400, { problem: '缺少 sessionId：面板必须说明改的是哪个会话。' })
                  }
                  if (action === 'sessionClear') {
                    overrides.clear(sessionId)
                  } else {
                    const r = overrides.set(sessionId, { enabled: action === 'sessionFollow' })
                    if (!r.ok) return sendJson(response, 400, { problem: r.problem })
                  }
                  return sendJson(response, 200, snapshot(sessionId))
                }

                if (action === 'setSessionCard') {
                  if (sessionId === undefined) return sendJson(response, 400, { problem: '缺少 sessionId。' })
                  const wanted = typeof body.cardId === 'string' && body.cardId !== '' ? body.cardId : undefined
                  const r = wanted === undefined
                    ? overrides.set(sessionId, { enabled: true })
                    : overrides.set(sessionId, { enabled: true, cardId: wanted })
                  if (!r.ok) return sendJson(response, 400, { problem: r.problem })
                  return sendJson(response, 200, snapshot(sessionId))
                }

                if (action === 'reload') {
                  // Cards are plain files; re-reading is the whole operation.
                  return sendJson(response, 200, snapshot(sessionId))
                }

                return sendJson(response, 400, { problem: `未知 action：${action || '(空)'}` })
              }

              sendJson(response, 404, { problem: 'no such route' })
            } catch (err) {
              try {
                sendJson(response, 500, { problem: String(err?.message ?? err) })
              } catch {
                /* the socket may already be gone */
              }
            }
          },
        }),
      'dsh-companion: panel routes',
    )
  })
}

export const name = 'dsh-companion'
