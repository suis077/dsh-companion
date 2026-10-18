/**
 * dsh-companion — Client half.
 *
 * Draws a floating persona-card panel into `shell.overlay`, the same slot the
 * TODO board uses. Rendered with React from the browser module table; no
 * Harness Client package is imported (that is the documented rule: such
 * imports change without notice and a throw blanks the slot entry).
 *
 * Styling uses only `--dsw-alias-*` theme tokens, so light/dark follow the host.
 *
 * Host data comes from `GET /persona-card/state`; writes go to
 * `POST /persona-card/set`. Both live in lib/index.js's route table.
 */
window.__ModuleLoader__.load({
  id: 'dsh-companion',
  factory (require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const API = '/persona-card'

    /**
     * How often the open panel re-reads its state.
     *
     * The usage figures are a live accumulator on the Host, so the panel has to
     * ask again to see them move. 10s keeps the number feeling live without
     * turning into a busy loop; polling is suspended while collapsed.
     */
    const REFRESH_MS = 10000

    /**
     * Build stamp shown in the panel.
     *
     * Bumped whenever the client bundle changes. It exists so a stale bundle —
     * the browser still running last launch's code — is visible instead of being
     * mistaken for a broken feature: "which build am I looking at?" was
     * otherwise unanswerable from the panel itself.
     */
    const PANEL_BUILD = 'p3'

    /** Small fetch helper that never throws; returns a parsed body or an error. */
    async function call (path, init) {
      try {
        const res = await fetch(`${API}${path}`, {
          credentials: 'same-origin',
          headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
          ...init,
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) return { ok: false, problem: body?.problem ?? `HTTP ${res.status}` }
        return { ok: true, body }
      } catch (err) {
        return { ok: false, problem: String(err?.message ?? err) }
      }
    }

    /** Shared inline style helpers built on theme tokens. */
    const S = {
      panel: {
        position: 'fixed',
        right: '18px',
        bottom: '18px',
        zIndex: 2147483000,
        width: '272px',
        borderRadius: '14px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.28))',
        // Solid, opaque background on purpose. The theme alias `bg-elevated`
        // exists in some skins with a TRANSPARENT (or semi-transparent) value,
        // and CSS fallbacks only fire when a variable is UNDEFINED — not when it
        // is defined-but-transparent. So relying on the alias left the panel
        // text floating over whatever sat behind it. Use a literal colour so
        // readability never depends on the active theme.
        background: '#ffffff',
        color: '#1a1a1a',
        boxShadow: '0 10px 30px rgba(0,0,0,0.28)',
        font: '13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
        overflow: 'hidden',
      },
      head: {
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '10px 12px',
        borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.22))',
        cursor: 'default',
      },
      title: { flex: '1 1 auto', fontWeight: 600, fontSize: '13px' },
      dot: (on) => ({
        width: '8px', height: '8px', borderRadius: '50%', flex: '0 0 auto',
        background: on ? 'var(--dsw-alias-state-success, #38a169)' : 'var(--dsw-alias-text-tertiary, #888)',
      }),
      body: { padding: '10px 12px', display: 'grid', gap: '8px' },
      row: { display: 'flex', alignItems: 'center', gap: '8px' },
      label: { color: '#555555', flex: '0 0 auto', fontSize: '12px' },
      cardName: { fontWeight: 600 },
      muted: { color: '#6b6b6b', fontSize: '12px' },
      btn: {
        appearance: 'none',
        border: '1px solid rgba(0,0,0,0.18)',
        background: '#f2f2f2',
        color: 'inherit',
        borderRadius: '8px',
        padding: '4px 9px',
        fontSize: '12px',
        cursor: 'pointer',
      },
      btnOn: {
        background: 'var(--dsw-alias-brand-primary, #3b82f6)',
        borderColor: 'var(--dsw-alias-brand-primary, #3b82f6)',
        color: '#fff',
      },
      iconBtn: {
        appearance: 'none', border: 'none', background: 'transparent', color: 'inherit',
        cursor: 'pointer', fontSize: '13px', padding: '2px 6px', borderRadius: '6px', opacity: 0.75,
      },
      select: {
        flex: '1 1 auto', minWidth: 0,
        background: '#f2f2f2',
        color: 'inherit',
        border: '1px solid rgba(0,0,0,0.18)',
        borderRadius: '8px', padding: '4px 6px', fontSize: '12px',
      },
      footer: { padding: '8px 12px', borderTop: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.22))', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' },
    }

    /**
     * The current session's id, from the slot props.
     *
     * Defensive on purpose: `useSessions` is a host-provided selector hook, and
     * a plugin must never blank its slot entry by assuming a prop exists. When
     * it is missing we return undefined and the panel simply hides the
     * per-session control rather than sending a session-less write.
     */
    function useSessionId (props) {
      const useSessions = props?.useSessions
      const summary = typeof useSessions === 'function'
        ? useSessions((s) => {
          const byId = s === undefined || s === null ? undefined : s.byId
          if (byId === undefined || byId === null) return undefined
          for (const row of Object.values(byId)) {
            if (row !== null && typeof row === 'object' && ((row.retainedBy ?? {}).mainView ?? 0) > 0) return row
          }
          return undefined
        })
        : undefined
      const id = summary === undefined || summary === null ? undefined : summary.id
      return typeof id === 'string' && id !== '' ? id : undefined
    }

    function PersonaPanel (props) {
      const [open, setOpen] = useState(true)
      const [state, setState] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')

      // The panel must say WHICH session it is toggling; the Host cannot infer
      // the browser's session from the request. Derive it the way the harness
      // itself does — the summary the main view retains. (Reading `s.current`
      // always yields undefined; dsh-todo-board documents that same trap.)
      const sessionId = useSessionId(props)

      const refresh = useCallback(async () => {
        const r = await call(`/state${sessionId === undefined ? '' : `?sessionId=${encodeURIComponent(sessionId)}`}`)
        if (r.ok) { setState(r.body); setError('') } else setError(r.problem)
      }, [sessionId])

      useEffect(() => { refresh() }, [refresh])

      // Auto-refresh while the panel is EXPANDED.
      //
      // The billing figures come from a Host-side accumulator that only moves
      // when a model step finishes, so without this the panel shows whatever it
      // fetched when it mounted and never moves again — the user has to press ⟳
      // to discover their own usage, which is not a thing a counter should
      // require.
      //
      // Polling stops when the panel is collapsed: a closed panel has no visible
      // numbers to keep current, and there is no reason to keep asking.
      useEffect(() => {
        if (!open) return undefined
        const timer = setInterval(() => { refresh() }, REFRESH_MS)
        return () => clearInterval(timer)
      }, [open, refresh])

      /** Apply a mutation, then re-read the authoritative state. */
      const mutate = useCallback(async (path, payload) => {
        setBusy(true)
        const r = await call(path, { method: 'POST', body: JSON.stringify({ ...(payload ?? {}), sessionId }) })
        setBusy(false)
        if (!r.ok) { setError(r.problem); return }
        setError('')
        refresh()
      }, [refresh, sessionId])

      if (!open) {
        return h('div', { style: { ...S.panel, width: 'auto' } },
          h('div', { style: { ...S.head, borderBottom: 'none' } },
            h('span', { style: S.dot(state?.effectiveEnabled) }),
            h('span', { style: S.title }, '人设卡'),
            h('button', { style: S.iconBtn, title: '展开', onClick: () => setOpen(true) }, '▸'),
          ),
        )
      }

      const cards = state?.cards ?? []
      const activeId = state?.activeCardId ?? ''
      const sessionEnabled = state?.session?.enabled

      return h('div', { style: S.panel },
        h('div', { style: S.head },
          h('span', { style: S.dot(state?.effectiveEnabled) }),
          h('span', { style: S.title }, '人设卡'),
          h('button', { style: S.iconBtn, title: '刷新', disabled: busy, onClick: refresh }, '⟳'),
          h('button', { style: S.iconBtn, title: '收起', onClick: () => setOpen(false) }, '▾'),
        ),

        h('div', { style: S.body },
          // ---- global card picker ----
          h('div', { style: S.row },
            h('span', { style: S.label }, '全局'),
            h('select', {
              style: S.select,
              value: activeId,
              disabled: busy || cards.length === 0,
              onChange: (e) => mutate('/set', { action: 'setGlobal', cardId: e.target.value || null }),
            },
              h('option', { value: '' }, cards.length === 0 ? '（没有人设卡）' : '（不启用）'),
              ...cards.map((c) => h('option', { key: c.id, value: c.id }, c.name)),
            ),
          ),

          // ---- current-session toggle ----
          // Hidden when the slot gave us no session: a session-less write would
          // be refused by the Host, and offering a button that cannot work is
          // worse than offering none.
          sessionId === undefined
            ? h('div', { style: S.muted }, '（拿不到当前会话，本会话开关未显示）')
            : h('div', { style: S.row },
              h('span', { style: S.label }, '本会话'),
              h('button', {
                style: { ...S.btn, ...(sessionEnabled === true ? S.btnOn : {}) },
                disabled: busy,
                title: '只影响当前会话，其它会话不受影响',
                onClick: () => mutate('/set', { action: sessionEnabled === true ? 'sessionOff' : 'sessionFollow' }),
              }, sessionEnabled === true ? '已开启' : sessionEnabled === false ? '已关闭' : '跟随全局'),
            ),

          // ---- status line ----
          h('div', { style: S.muted },
            state?.effectiveCard
              ? `生效中：${state.effectiveCard}（${state.effectiveReason}）`
              : `未注入人设（${state?.effectiveReason ?? '未知'}）`,
          ),

          // ---- the persona's memory, made visible ----
          // The memory feature first landed invisibly — it only lived in the
          // prompt, so the panel looked identical whether or not it was working.
          // This block makes it observable: affinity, mood, and the latest few
          // chapters. A missing/corrupt file is surfaced, not hidden.
          (() => {
            const mem = state?.memory
            if (mem === undefined) return null
            if (mem.problem !== undefined) {
              return h('div', { style: S.muted }, `记忆读不到：${mem.problem}`)
            }
            const rows = []
            // Headline: affinity + mood + count in one line.
            const headBits = []
            if (Number.isFinite(mem.affinity)) headBits.push(`好感 ${mem.affinity}`)
            if (mem.mood !== '') headBits.push(mem.mood)
            if (mem.count > 0) headBits.push(`${mem.count} 条记忆`)
            if (headBits.length > 0) {
              rows.push(h('div', { key: 'mem-head', style: { opacity: 0.9 } },
                `🧠 ${headBits.join(' · ')}`))
            }
            if (mem.traits?.length > 0) {
              rows.push(h('div', { key: 'mem-traits', style: { ...S.muted, fontSize: '11px' } },
                `性格：${mem.traits.join('、')}`))
            }
            if (mem.recent?.length > 0) {
              for (const c of mem.recent) {
                rows.push(h('div', { key: c.summary + c.kind, style: { ...S.muted, fontSize: '11px', paddingLeft: '8px' } },
                  `· ${c.summary}`))
              }
            }
            // Surface a loss, never hide it.
            if (mem.state === 'corrupt') {
              rows.push(h('div', { key: 'mem-warn', style: { ...S.muted, color: '#e2a13d' } },
                '⚠️ 记忆文件读不出来（可能被写坏）'))
            } else if (mem.state === 'missing' && mem.hasBackup) {
              rows.push(h('div', { key: 'mem-warn', style: { ...S.muted, color: '#e2a13d' } },
                `⚠️ 记忆文件丢了，备份有 ${mem.backupChapters} 条`))
            }
            if (rows.length === 0) {
              rows.push(h('div', { key: 'mem-empty', style: S.muted }, '还没有记忆（任务外的闲聊才会被记下）'))
            }
            return h('div', {
              style: { display: 'grid', gap: '2px', borderTop: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.18))', paddingTop: '6px' },
            }, ...rows)
          })(),

          // ---- the two ledgers, split by how the turn was paid for ----
          // THIS is the answer to "am I burning credits or my own money?".
          // Credits and yuan are rendered as two separate rows and are never
          // summed: they are different units. A partial credit total says so
          // rather than looking like a small bill.
          //
          // The headline is the PROCESS total ("since I opened the app"), not
          // this chat's share — a per-chat number would read as 0 in every new
          // chat. The current chat's share is shown underneath when it differs.
          (() => {
            const b = state?.billing
            // ALWAYS render something here.
            //
            // Returning null when the payload had no `billing` made a missing
            // field look identical to a working panel with nothing to report:
            // the user saw an empty area and had no way to tell whether the
            // figure was zero, unknown, or never arrived. A diagnostic line is
            // better than silence, and it names which build is live so a stale
            // bundle cannot masquerade as a broken feature.
            if (b === undefined) {
              return h('div', { style: S.muted },
                state === null || state === undefined
                  ? `计费：等待首次读取（面板 v${PANEL_BUILD}）`
                  : `计费：后端未返回 billing 字段（面板 v${PANEL_BUILD}）`)
            }
            if (b.problem !== undefined) return h('div', { style: S.muted }, `计费读不到：${b.problem}`)

            const rows = []
            if (b.steps === 0) {
              rows.push(h('div', { key: 'z', style: S.muted },
                b.note ?? '自本次启动以来还没有模型步骤'))
            } else {
              if (b.credits?.steps > 0) {
                rows.push(h('div', { key: 'c' },
                  `积分消耗 ${b.credits.complete ? '' : '至少 '}${b.credits.amount} 积分`,
                  h('span', { style: { opacity: 0.7 } }, ` · ${b.credits.steps} 步 · ${b.credits.tokens.toLocaleString()} tokens`),
                  b.credits.complete ? null : h('span', { title: '有模型的倍率未知，实际积分会更多' }, ' *'),
                ))
              }
              if (b.money?.steps > 0) {
                rows.push(h('div', { key: 'm' },
                  `Token 扣费 ¥${b.money.amount}`,
                  h('span', { style: { opacity: 0.7 } }, ` · ${b.money.steps} 步 · ${b.money.tokens.toLocaleString()} tokens`),
                ))
              }
              if (b.unknown?.steps > 0) {
                rows.push(h('div', { key: 'u', style: { opacity: 0.75 } },
                  `未识别 provider ${b.unknown.steps} 步（未并入上面两本账）`))
              }
              // "since launch" so the scope is never ambiguous.
              rows.push(h('div', { key: 'scope', style: { opacity: 0.65, fontSize: '11px' } },
                '↑ 自本次启动累计'))
              // This chat's own share, only when it is a real subset.
              if (b.session !== undefined && b.session.steps > 0 && b.session.steps !== b.steps) {
                rows.push(h('div', { key: 's', style: { opacity: 0.75 } },
                  `本对话：${b.session.credits.steps > 0 ? `${b.session.credits.amount} 积分` : ''}`
                  + `${b.session.credits.steps > 0 && b.session.money.steps > 0 ? ' · ' : ''}`
                  + `${b.session.money.steps > 0 ? `¥${b.session.money.amount}` : ''}`
                  + `（${b.session.steps} 步）`))
              }
            }
            if (b.multiplierStatus?.ok !== true) {
              // "Still loading" and "failed" must not read the same.
              //
              // The first state read after launch always finds an empty cache
              // and fills about a second later, so a healthy install briefly
              // shows this branch. Presenting that as a permanent failure is
              // what made a working setup look broken.
              const loading = b.multiplierStatus?.loading === true
              rows.push(h('div', {
                key: 'ms',
                style: { opacity: 0.75, ...(loading ? {} : { color: '#e2a13d' }) },
              },
                loading
                  ? '倍率：正在查询 workbuddy…（约 1 秒后自动刷新）'
                  : `倍率未知：${b.multiplierStatus?.problem ?? '?'} — 积分按 0 计并标记为不完整`))
            } else {
              // Name the model this session is ACTUALLY using, and only that one.
              //
              // Two earlier attempts got this wrong in opposite directions:
              //   - deriving it from `credits.models` hid the row until a step
              //     had been recorded, i.e. exactly when the user looks first;
              //   - falling back to the first three table entries showed models
              //     nobody was using (hy4-preview / hy3 / hy3-x) — worse than
              //     silence, because it looks like real information.
              // The Host now reports `multiplierStatus.current` from the agent's
              // own `options.model`, so there is nothing left to guess.
              const cur = b.multiplierStatus.current
              if (cur !== undefined && cur.model !== undefined) {
                const rate = Number.isFinite(cur.multiplier) ? `×${cur.multiplier}` : '倍率未列出'
                rows.push(h('div', { key: 'mult', style: { opacity: 0.7, fontSize: '11px' } },
                  `当前模型倍率：${cur.model} ${rate}`
                  + (cur.provider !== '' ? `（${cur.provider}）` : '')
                  + ' · 实时取自 workbuddy'))
              }
            }
            return h('div', { style: { display: 'grid', gap: '2px' } }, ...rows)
          })(),

          // ---- the whale's own ledger, labelled for what it is ----
          state?.usage?.problem !== undefined
            ? h('div', { style: S.muted }, `挂件账本读不到：${state.usage.problem}`)
            : state?.usage === undefined
              ? null
              : h('div', { style: { ...S.muted, display: 'grid', gap: '2px', borderTop: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.18))', paddingTop: '6px' } },
                h('div', { title: '挂件只读 source.model，按 DeepSeek 人民币价目表估算，不看 provider —— 积分服务的轮次也会被它贴上人民币标签' },
                  `挂件账本 ¥${state.usage.today} 今日 · ¥${state.usage.lifetime} 累计（估算，非真实扣费）`),
                state.usage.perCard?.length > 0
                  ? h('div', null,
                    '按卡：',
                    state.usage.perCard.map((c) => ` ${c.name} ¥${c.yuan}`).join(' ·'),
                    state.usage.coverage < 1 ? h('span', null, `（覆盖 ${Math.round(state.usage.coverage * 100)}%）`) : null,
                  )
                  : null,
              ),

          error !== '' ? h('div', { style: { ...S.muted, color: '#ff6b6b' } }, `错误：${error}`) : null,
        ),

        // ---- footer ----
        h('div', { style: S.footer },
          h('span', { style: S.muted }, cards.length === 0 ? '卡片放在 $DSH_HOME/persona-cards' : `${cards.length} 张卡`),
          h('button', {
            style: S.btn,
            disabled: busy,
            title: '重新读取卡片与账本',
            onClick: () => mutate('/set', { action: 'reload' }),
          }, '刷新'),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply (ctx) {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          { name: 'shell.overlay', id: 'persona-card', order: 41, label: '人设卡' },
          PersonaPanel,
        ))
      },
    }
  },
})
