/**
 * Strategies, compiled to a target-exposure series.
 *
 * **Ported from `crucible/services/crucible/src/engine/strategies.ts`.** The rules are unchanged —
 * this is the part of the frozen service that is genuinely good and there was nothing to fix in it.
 * Two things did change, and both are at the boundary rather than in the logic:
 *
 *   1. A signal's target is **integer basis points**, not a float fraction. That is where the float
 *      world ends: everything downstream of here is `bigint`. See `src/money.ts`.
 *   2. Nothing in this file reads a clock or a random number. There is no import that could — the
 *      only time a rule has is the bar's own index. See `src/rng.ts`.
 *
 * Every rule reduces to one number per bar: the fraction of the account that should be held in the
 * base asset once that bar has CLOSED, between 0 and 10000 bps. Expressing binary trend rules and
 * fractional ones (grid, DCA) in the same currency is what lets a single execution loop handle all
 * of them — and it makes position sizing an execution concern rather than something each rule
 * re-implements slightly differently.
 *
 * `null` means "no opinion, leave the position alone", which is not the same as 0 ("be flat").
 * Warm-up bars are null; a rule that wants to be in cash says 0.
 *
 * ## Carrying state between evaluations
 *
 * Most rules here are pure functions of the window: an SMA cross over the last 500 bars is the same
 * answer whoever asks. Three are not. A grid's anchor is the running high since it started, an ATR
 * trailing stop remembers whether it is in a position and how high the trade has been, and DCA
 * counts bars against a schedule. All three are accumulators over the bot's WHOLE life, not over
 * whatever window happens to be loaded.
 *
 * A backtest never noticed, because it sees the entire series in one pass. The live runner re-fetches
 * a sliding window every tick, so re-deriving those accumulators from scratch reset them roughly
 * once a minute: the grid re-anchored to the window's high, the trailing stop forgot its position,
 * and DCA — which fired when the bar INDEX was a multiple of its interval — either never fired or
 * bought its entire remaining allocation in one go. The frozen file's own comment at
 * `crucible/services/crucible/src/engine/strategies.ts` records this, and the fix is carried
 * forward with it: the runner hands back what it was given, plus the index of the first bar it has
 * not folded in yet.
 */

import { toTargetBps, type TargetBps } from './money.ts'
import type { StrategyId, StrategyParams } from './catalog.ts'
import {
  atr,
  bollinger,
  ema,
  highestPrior,
  lowestPrior,
  macd,
  rsi,
  sma,
  toIndicatorSpace,
  type Bar,
} from './indicators.ts'

export interface BarSignal {
  /** Desired base-asset share of equity after this bar in bps, or null to hold. */
  readonly target: TargetBps | null
  readonly reason: string
}

export interface StrategyRuntime {
  /** Accumulators returned by the previous evaluation. */
  readonly state: Readonly<Record<string, number>>
  /** First bar not yet folded into `state`. Everything earlier is history. */
  readonly from: number
}

export interface StrategyRun {
  readonly signals: readonly BarSignal[]
  /** Accumulators to persist and hand back on the next evaluation. */
  readonly state: Record<string, number>
}

const HOLD: BarSignal = { target: null, reason: '' }
const FULL = 10_000
const FLAT = 0

/** Round a param that indexes bars — a 20.5-period average is not a thing. */
const bars = (value: number | undefined, fallback: number): number =>
  Math.max(1, Math.round(value ?? fallback))

/** One rung of N, as whole basis points. Rounds down, so a grid never targets more than 100%. */
const share = (numerator: number, denominator: number): TargetBps =>
  denominator <= 0 ? FLAT : toTargetBps(numerator / denominator)

/**
 * Compile a rule to a target-exposure series.
 *
 * Called with no `runtime` — which is what a backtest does — every accumulator starts empty and
 * every bar is evaluated, which is the frozen behaviour exactly.
 */
export function compileSignals(
  id: StrategyId,
  params: StrategyParams,
  candles: readonly Bar[],
  runtime?: StrategyRuntime,
): StrategyRun {
  const n = candles.length
  const out: BarSignal[] = new Array<BarSignal>(n).fill(HOLD)
  const price = toIndicatorSpace(candles.map((c) => c.c))
  const seed = runtime?.state ?? {}
  const start = Math.max(0, Math.min(runtime?.from ?? 0, n))
  const at = (i: number): number => price[i] as number

  switch (id) {
    case 'buy_hold': {
      for (let i = 0; i < n; i++) out[i] = { target: FULL, reason: 'hold' }
      if (n > 0) out[0] = { target: FULL, reason: 'buy and hold' }
      return { signals: out, state: {} }
    }

    case 'sma_cross':
    case 'ema_cross': {
      const avg = id === 'sma_cross' ? sma : ema
      const fastPeriod = bars(params['fast'], id === 'sma_cross' ? 20 : 12)
      const slowPeriod = bars(params['slow'], id === 'sma_cross' ? 50 : 26)
      const fast = avg(price, fastPeriod)
      const slow = avg(price, slowPeriod)
      for (let i = Math.max(start, 1); i < n; i++) {
        const f = fast[i]
        const s = slow[i]
        const pf = fast[i - 1]
        const ps = slow[i - 1]
        if (f == null || s == null || pf == null || ps == null) continue
        if (pf <= ps && f > s) {
          out[i] = { target: FULL, reason: `fast ${fastPeriod} crossed above slow ${slowPeriod}` }
        } else if (pf >= ps && f < s) {
          out[i] = { target: FLAT, reason: `fast ${fastPeriod} crossed below slow ${slowPeriod}` }
        }
      }
      return { signals: out, state: {} }
    }

    case 'macd_trend': {
      const { macd: line, signal } = macd(
        price,
        bars(params['fast'], 12),
        bars(params['slow'], 26),
        bars(params['signal'], 9),
      )
      for (let i = Math.max(start, 1); i < n; i++) {
        const m = line[i]
        const s = signal[i]
        const pm = line[i - 1]
        const ps = signal[i - 1]
        if (m == null || s == null || pm == null || ps == null) continue
        if (pm <= ps && m > s) out[i] = { target: FULL, reason: 'MACD crossed above signal' }
        else if (pm >= ps && m < s) out[i] = { target: FLAT, reason: 'MACD crossed below signal' }
      }
      return { signals: out, state: {} }
    }

    case 'rsi_reversion': {
      const period = bars(params['period'], 14)
      const oversold = params['oversold'] ?? 30
      const overbought = params['overbought'] ?? 70
      const series = rsi(price, period)
      for (let i = Math.max(start, 1); i < n; i++) {
        const r = series[i]
        const prev = series[i - 1]
        if (r == null || prev == null) continue
        // Trigger on the CROSS, not the level. Holding "RSI < 30" as a standing buy signal re-enters
        // on every bar of a long slide, which the execution loop would see as a series of no-op
        // rebalances.
        if (prev >= oversold && r < oversold) {
          out[i] = { target: FULL, reason: `RSI ${r.toFixed(1)} fell below ${oversold}` }
        } else if (prev <= overbought && r > overbought) {
          out[i] = { target: FLAT, reason: `RSI ${r.toFixed(1)} rose above ${overbought}` }
        }
      }
      return { signals: out, state: {} }
    }

    case 'bollinger_breakout': {
      const period = bars(params['period'], 20)
      const deviations = params['deviations'] ?? 2
      const { middle, upper } = bollinger(price, period, deviations)
      for (let i = Math.max(start, 1); i < n; i++) {
        const u = upper[i]
        const m = middle[i]
        if (u == null || m == null) continue
        if (at(i) > u) out[i] = { target: FULL, reason: `closed above the upper band (${deviations}σ)` }
        // Exit at the middle band rather than the lower one: waiting for the lower band gives back
        // the entire move on every failed breakout.
        else if (at(i) < m) out[i] = { target: FLAT, reason: 'closed back under the middle band' }
      }
      return { signals: out, state: {} }
    }

    case 'donchian_breakout': {
      const entry = bars(params['entry'], 20)
      const exit = bars(params['exit'], 10)
      const high = highestPrior(toIndicatorSpace(candles.map((c) => c.h)), entry)
      const low = lowestPrior(toIndicatorSpace(candles.map((c) => c.l)), exit)
      for (let i = start; i < n; i++) {
        const hi = high[i]
        const lo = low[i]
        if (hi != null && at(i) > hi) out[i] = { target: FULL, reason: `broke the ${entry}-bar high` }
        else if (lo != null && at(i) < lo) out[i] = { target: FLAT, reason: `broke the ${exit}-bar low` }
      }
      return { signals: out, state: {} }
    }

    case 'atr_trailing': {
      const trendPeriod = bars(params['trend'], 50)
      const atrPeriod = bars(params['atr'], 14)
      const multiple = params['multiple'] ?? 3
      const trend = sma(price, trendPeriod)
      const range = atr(candles, atrPeriod)
      // Whether a trade is open, and how high it has been, are properties of the TRADE — they
      // outlive any window the stop happens to be recomputed over.
      let inPosition = seed['inPosition'] === 1
      let peak = seed['peak'] ?? 0
      for (let i = start; i < n; i++) {
        const t = trend[i]
        const a = range[i]
        if (t == null || a == null) continue
        if (!inPosition) {
          if (at(i) > t) {
            inPosition = true
            peak = at(i)
            out[i] = { target: FULL, reason: `closed above the ${trendPeriod}-bar average` }
          }
          continue
        }
        if (at(i) > peak) peak = at(i)
        const stop = peak - a * multiple
        if (at(i) < stop) {
          inPosition = false
          out[i] = { target: FLAT, reason: `stopped out ${multiple}× ATR below the peak` }
        }
      }
      return { signals: out, state: { inPosition: inPosition ? 1 : 0, peak } }
    }

    case 'grid': {
      const rungs = bars(params['rungs'], 8)
      const spacing = Math.max(0.001, (params['spacing'] ?? 2) / 100)
      // The grid is anchored to the running high rather than a fixed start price. A fixed anchor
      // makes the whole grid meaningless the moment the market leaves its original range — it
      // either fills every rung and never sells, or never fills one at all.
      let anchor = seed['anchor'] ?? (start < n ? at(start) : 0)
      let filled = seed['filled'] ?? 0
      for (let i = start; i < n; i++) {
        if (at(i) > anchor) anchor = at(i)
        const drop = anchor > 0 ? (anchor - at(i)) / anchor : 0
        const want = Math.max(0, Math.min(rungs, Math.floor(drop / spacing)))
        if (want !== filled) {
          const direction = want > filled ? 'bought' : 'sold'
          filled = want
          out[i] = {
            target: share(want, rungs),
            reason: `${direction} to ${want}/${rungs} rungs, ${(drop * 100).toFixed(1)}% below the high`,
          }
        }
      }
      return { signals: out, state: { anchor, filled } }
    }

    case 'dca': {
      const every = bars(params['every'], 7)
      const slices = bars(params['slices'], 12)
      // Counted rather than derived from the bar index. `i % every` is a statement about position in
      // the loaded array, and the loaded array is a window rather than the bot's life, so it fired
      // on whichever bars happened to land on the multiple this minute.
      let bought = seed['bought'] ?? 0
      // Bars elapsed since the last slice, seeded at `every` so the first bar of a fresh run buys
      // immediately — which is what `i % every` did at i = 0.
      let sinceLast = seed['sinceLast'] ?? every
      for (let i = start; i < n; i++) {
        if (bought >= slices) break
        if (sinceLast >= every) {
          sinceLast = 0
          bought++
          out[i] = { target: share(bought, slices), reason: `slice ${bought} of ${slices}` }
        }
        sinceLast++
      }
      return { signals: out, state: { bought, sinceLast } }
    }
  }
}
