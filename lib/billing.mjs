/**
 * dsh-companion — billing split: credits vs money.
 *
 * THE PROBLEM THIS SOLVES, stated plainly:
 *
 * A turn can be served by different providers, and they are charged differently:
 *
 *   - `deepseek`  → real money from the user's DeepSeek balance, priced by the
 *                   public CNY-per-million-token table (peak/valley rates);
 *   - `workbuddy` → credits from a WorkBuddy subscription, priced by a per-model
 *                   multiplier (`creditMultiplier`).
 *
 * The whale widget cannot tell these apart. It reads only `source.model`
 * (verified in its own code) and prices EVERY turn from the DeepSeek money
 * table — so a credit-funded turn gets a fabricated CNY figure attached to it.
 * That fabricated figure is what made the ledger look inconsistent: the
 * accounting book says "balance barely moved" while the event log claims money
 * was spent, and both are in the same file.
 *
 * What we read instead is the authoritative per-step record the session already
 * carries: `assistant/message` → `data.message.source = { kind, provider, model }`.
 * Verified on a real log: every step of a WorkBuddy session carries
 * `provider: 'workbuddy'`.
 *
 * CREDIT FORMULA, verified rather than assumed:
 *   credits = tokens / 1e6 × creditMultiplier
 * dsh-connect-workbuddy's own README states a ~25k-token probe reports
 * `credit 0.02`; with the `glm-5.3` multiplier of 0.79, 25000/1e6 × 0.79 =
 * 0.0198 ≈ 0.02. The per-1k reading gives 19.8, off by 1000×, so the
 * per-million reading is the correct one.
 */

/** Providers whose requests are paid from a credit pool, not from money. */
export const CREDIT_PROVIDERS = {
  workbuddy: { region: 'cn', label: 'WorkBuddy 国内版' },
  'workbuddy-global': { region: 'global', label: 'WorkBuddy 国际版' },
}

/**
 * Providers whose requests are billed as money against the DeepSeek balance.
 *
 * `deepseek-official` is the id the desktop build actually reports (observed in
 * a real session log); `deepseek` is kept because it is the spelling used in the
 * provider config and by older builds. Matching only one of them silently filed
 * real money spend under "unrecognised", which is the worst possible bucket —
 * the user sees ¥0.00 while their balance drops.
 */
export const MONEY_PROVIDERS = {
  deepseek: { label: 'DeepSeek 官方' },
  'deepseek-official': { label: 'DeepSeek 官方' },
}

/**
 * Classify one request source.
 *
 * @param {{provider?: string, model?: string} | undefined} source
 * @returns {{kind: 'credits' | 'money' | 'unknown', provider: string, model: string, label?: string}}
 */
export function classifySource (source) {
  const provider = typeof source?.provider === 'string' && source.provider !== '' ? source.provider : ''
  const model = typeof source?.model === 'string' ? source.model : ''
  if (CREDIT_PROVIDERS[provider] !== undefined) {
    return { kind: 'credits', provider, model, label: CREDIT_PROVIDERS[provider].label }
  }
  if (MONEY_PROVIDERS[provider] !== undefined) {
    return { kind: 'money', provider, model, label: MONEY_PROVIDERS[provider].label }
  }
  // An unrecognised provider is NOT guessed at. Calling it money would invent a
  // charge; calling it credits would hide one. It goes to its own bucket.
  return { kind: 'unknown', provider, model }
}

/**
 * The tokens one step actually billed, matching the whale's own accounting so
 * the two agree: DSH guarantees `reasoningTokens ⊆ outputTokens`, so reasoning
 * must NOT be added again (the widget documents the same fix).
 *
 * @param {{inputTokens?: number, cacheReadTokens?: number, outputTokens?: number}} usage
 */
export function billedTokens (usage) {
  const input = Number(usage?.inputTokens) || 0
  const cache = Number(usage?.cacheReadTokens) || 0
  const output = Number(usage?.outputTokens) || 0
  return { input, cache, output, total: input + cache + output }
}

/**
 * Credits consumed by one step.
 *
 * @param {number} tokens
 * @param {number | undefined} multiplier
 * @returns {number | undefined} undefined when the multiplier is unknown, so the
 *   caller reports "unknown" instead of silently charging zero.
 */
export function creditsFor (tokens, multiplier) {
  if (!Number.isFinite(tokens) || tokens < 0) return undefined
  if (!Number.isFinite(multiplier) || multiplier < 0) return undefined
  return (tokens / 1e6) * multiplier
}

/**
 * DeepSeek's published CNY price per million tokens, idle vs peak.
 *
 * Source: the whale widget's own table (`dsh-whale-widget/lib/index.js`, BASE_PRICE),
 * which tracks api-docs.deepseek.com. Peak = idle × 2; peak hours are 9:00–12:00
 * and 14:00–18:00 Beijing time on weekdays, with weekends and holidays at idle.
 *
 * These figures are an ESTIMATE for display, not an invoice: the authoritative
 * charge is whatever DeepSeek bills. They are here so a money-funded turn shows
 * a plausible ¥ figure instead of a bare token count.
 */
export const DEEPSEEK_CNY_PER_MILLION = {
  'deepseek-flash': { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
  'deepseek-v4.1-flash': { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
  'deepseek-v4-pro': { hit: [0.15, 0.30], miss: [4.5, 9.0], out: [13.5, 27.0] },
  _default: { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
}

/** Whether a timestamp (ms) falls in DeepSeek's peak window, Beijing time. */
export function isPeakTime (ms) {
  const d = new Date(ms + 8 * 3600 * 1000) // shift to Beijing wall clock
  const day = d.getUTCDay()
  if (day === 0 || day === 6) return false // weekends are idle
  const h = d.getUTCHours()
  return (h >= 9 && h < 12) || (h >= 14 && h < 18)
}

/**
 * Estimate the CNY cost of one money-funded step.
 *
 * @param {{input?: number, cache?: number, output?: number}} tokens
 * @param {string} model
 * @param {number} [atMs] - the step's timestamp, for the peak flag.
 * @returns {number | undefined} undefined when the token counts are unusable.
 */
export function moneyFor (tokens, model, atMs = Date.now()) {
  const input = Number(tokens?.input)
  const cache = Number(tokens?.cache)
  const output = Number(tokens?.output)
  if (!Number.isFinite(input) || !Number.isFinite(cache) || !Number.isFinite(output)) return undefined
  if (input < 0 || cache < 0 || output < 0) return undefined
  const key = String(model ?? '').toLowerCase()
  const p = DEEPSEEK_CNY_PER_MILLION[key] ?? DEEPSEEK_CNY_PER_MILLION._default
  const off = isPeakTime(atMs) ? 1 : 0
  return (cache / 1e6) * p.hit[off] + (input / 1e6) * p.miss[off] + (output / 1e6) * p.out[off]
}

// ---------------------------------------------------------------------------
// Accumulator
// ---------------------------------------------------------------------------

/**
 * Running totals for one session, split by how the turn was paid for.
 *
 * Two independent ledgers on purpose: summing them would produce a number in no
 * unit at all, which is exactly the mistake this module exists to correct.
 */
export class BillingSplit {
  constructor () {
    this.credits = { tokens: 0, amount: 0, steps: 0, models: new Set(), multiplierKnown: true }
    this.money = { tokens: 0, amount: 0, steps: 0, models: new Set(), priceKnown: true }
    this.unknown = { tokens: 0, steps: 0, providers: new Set() }
  }

  /**
   * Record one step.
   *
   * @param {object} options
   * @param {{provider?: string, model?: string}} options.source
   * @param {object} options.usage - the step's token counts.
   * @param {(model: string) => number | undefined} [options.multiplierFor]
   *   resolves the credit multiplier for a model. Missing means "unknown", which
   *   is recorded rather than treated as zero.
   * @param {number} [options.moneyAmount] - CNY for a money step, when the caller
   *   already knows it. When omitted, the published price table is used to
   *   estimate it — a bare token count is not useful for "how much did I spend".
   * @param {number} [options.atMs] - the step's timestamp, for the peak flag.
   * @returns {{kind: string, tokens: number, credits?: number, amount?: number}}
   */
  add ({ source, usage, multiplierFor, moneyAmount, atMs }) {
    const cls = classifySource(source)
    const t = billedTokens(usage)

    if (cls.kind === 'credits') {
      this.credits.tokens += t.total
      this.credits.steps += 1
      if (cls.model !== '') this.credits.models.add(cls.model)
      const m = typeof multiplierFor === 'function' ? multiplierFor(cls.model) : undefined
      const credits = creditsFor(t.total, m)
      if (credits === undefined) this.credits.multiplierKnown = false
      else this.credits.amount += credits
      return { kind: 'credits', tokens: t.total, credits }
    }

    if (cls.kind === 'money') {
      this.money.tokens += t.total
      this.money.steps += 1
      if (cls.model !== '') this.money.models.add(cls.model)
      const amount = Number.isFinite(moneyAmount)
        ? moneyAmount
        : moneyFor(t, cls.model, Number.isFinite(atMs) ? atMs : Date.now())
      if (Number.isFinite(amount)) this.money.amount += amount
      else this.money.priceKnown = false
      return { kind: 'money', tokens: t.total, amount: Number.isFinite(amount) ? amount : undefined }
    }

    this.unknown.tokens += t.total
    this.unknown.steps += 1
    if (cls.provider !== '') this.unknown.providers.add(cls.provider)
    return { kind: 'unknown', tokens: t.total }
  }

  /**
   * A JSON-safe snapshot. Sets become arrays; every figure is accompanied by the
   * reason it might be incomplete.
   */
  toJSON () {
    return {
      credits: {
        tokens: this.credits.tokens,
        amount: Number(this.credits.amount.toFixed(6)),
        steps: this.credits.steps,
        models: [...this.credits.models],
        // A credit total is only trustworthy when every step's multiplier was
        // known; otherwise it is a floor, and saying so prevents the panel from
        // presenting a partial number as the whole bill.
        complete: this.credits.multiplierKnown,
      },
      money: {
        tokens: this.money.tokens,
        amount: Number(this.money.amount.toFixed(6)),
        steps: this.money.steps,
        models: [...this.money.models],
        // False when a money step's price could not be resolved; the amount is
        // then a floor. Same honesty rule as the credit total.
        complete: this.money.priceKnown,
      },
      unknown: {
        tokens: this.unknown.tokens,
        steps: this.unknown.steps,
        providers: [...this.unknown.providers],
      },
    }
  }
}

/**
 * Parse the per-step records out of a decoded session log's events.
 *
 * Kept pure (takes events, returns rows) so it can be unit tested without a
 * running DSH, and so the same parser can serve a live event stream later.
 *
 * @param {Array<{type?: string, data?: any, time?: number}>} events
 * @returns {Array<{turn: number, at: number, provider: string, model: string, kind: string, tokens: number, input: number, cache: number, output: number}>}
 */
export function parseStepRecords (events) {
  const rows = []
  for (const e of Array.isArray(events) ? events : []) {
    if (e?.type !== 'assistant/message') continue
    const d = e.data
    if (d === null || typeof d !== 'object') continue
    const usage = d.usage
    if (usage === null || typeof usage !== 'object') continue
    const cls = classifySource(d.message?.source)
    const t = billedTokens(usage)
    rows.push({
      turn: Number(d.turn) || 0,
      // The event's own timestamp, so a money step is priced at the rate that
      // applied when it actually ran (peak hours cost double).
      at: Number.isFinite(e.time) ? e.time : 0,
      provider: cls.provider,
      model: cls.model,
      kind: cls.kind,
      tokens: t.total,
      input: t.input,
      cache: t.cache,
      output: t.output,
    })
  }
  return rows
}

/**
 * Summarise parsed rows into the two ledgers.
 *
 * @param {Array<object>} rows - from {@link parseStepRecords}.
 * @param {(model: string) => number | undefined} [multiplierFor]
 */
export function summariseSplit (rows, multiplierFor) {
  const split = new BillingSplit()
  for (const r of rows) {
    split.add({
      source: { provider: r.provider, model: r.model },
      usage: { inputTokens: r.input, cacheReadTokens: r.cache, outputTokens: r.output },
      multiplierFor,
      atMs: r.at,
    })
  }
  return split.toJSON()
}
