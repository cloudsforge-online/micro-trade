/**
 * The backtest engine.
 *
 * **Ported from `crucible/services/crucible/src/engine/backtest.ts`**, with the money rewritten in
 * `bigint` and the run made reproducible from what is stored rather than from what was in memory.
 *
 * ## The one rule that makes a backtest honest
 *
 * A signal derived from bar `i`'s close is filled at bar `i + 1`'s **open**. Filling at bar `i`'s
 * own close would let the simulation trade on a price it only knew after the fact, which is the
 * difference between a backtest and a fantasy. It also means the final bar's signal is never acted
 * on — there is no next bar to fill it at. This is the frozen engine's rule
 * (`crucible/services/crucible/src/engine/backtest.ts`) and it is carried forward exactly.
 *
 * ## The one rule that makes a backtest worth anything
 *
 * **Determinism.** Same strategy, same series, same seed ⇒ byte-identical result. A user compares
 * two runs and concludes one rule beats another; if the same input can give two answers, that
 * conclusion is noise.
 *
 * It is enforced structurally, not by discipline:
 *
 *   * Nothing here imports `Date`, and `Math.random` appears nowhere. The only randomness is
 *     `seededRandom(seed)` (`src/rng.ts`), threaded in as a parameter.
 *   * The result carries a `digest` — a sha256 over the canonicalised output — so "these two runs
 *     agree" is a byte comparison rather than a walk over two object graphs, and the claim is stored
 *     on the row where a support conversation can check it.
 *   * The seed is not decorative. It perturbs execution slippage, so two seeds genuinely disagree.
 *     A seed that was recorded and ignored would make "same seed, same result" true for the
 *     uninteresting reason that nothing consumed it.
 */

import { createHash } from 'node:crypto'
import type { AssetCode } from '@cloudsforge/contracts-chain'
import {
  BPS_SCALE,
  applyBps,
  amountTo,
  slippedPrice,
  unitsForCents,
  valueInCents,
} from './money.ts'
import { seededRandom, jitterBps } from './rng.ts'
import { compileSignals } from './strategies.ts'
import { computeMetrics, type BacktestMetrics, type EquityPoint, type SimulatedFill } from './performance.ts'
import type { Bar } from './indicators.ts'
import type { StrategyId, StrategyParams, Timeframe } from './catalog.ts'

/**
 * Points kept in a stored equity curve. A full-window run produces one point per bar, which is both
 * more than any chart can draw and enough JSONB to make listing runs slow. The curve is decimated
 * evenly, always keeping the first and last point so the endpoints of the chart match the reported
 * metrics.
 *
 * Metrics are computed on the FULL curve before decimation — sampling first would understate max
 * drawdown by skipping the trough.
 */
const MAX_CURVE_POINTS = 600

/**
 * Rebalances smaller than this share of equity are skipped.
 *
 * Without a threshold, a fractional strategy re-trades a rounding error every single bar and pays a
 * fee for it, which quietly turns a profitable rule into a losing one. 20 bps, as in the frozen
 * engine (`MIN_REBALANCE = 0.002`).
 */
const MIN_REBALANCE_BPS = 20n

/**
 * How far the seed may move a fill price, in basis points either side of the modelled slippage.
 *
 * Small on purpose. This is not a claim that execution is random — it is an acknowledgement that a
 * single slippage number is a point estimate of a distribution, and that a strategy whose edge
 * disappears under ±5 bps of execution noise did not have an edge. Reporting one number from one
 * draw would hide that; making the draw reproducible from a stored seed means a user can re-run it
 * and get the same answer, and can change the seed to find out whether the answer was luck.
 */
const EXECUTION_JITTER_BPS = 5

export interface RunInput {
  readonly bars: readonly Bar[]
  readonly strategyId: StrategyId
  readonly params: StrategyParams
  readonly timeframe: Timeframe
  readonly asset: AssetCode
  readonly startCash: bigint
  readonly feeBps: number
  readonly slippageBps: number
  readonly seed: number
}

export interface RunResult {
  readonly metrics: BacktestMetrics
  readonly fills: readonly SimulatedFill[]
  /** Decimated for charting. Metrics above are computed on the full curve. */
  readonly equity: readonly EquityPoint[]
  readonly from: number
  readonly to: number
  /** sha256 over the canonicalised result. The determinism claim, written down. */
  readonly digest: string
}

function decimate(curve: readonly EquityPoint[]): EquityPoint[] {
  if (curve.length <= MAX_CURVE_POINTS) return [...curve]
  const step = (curve.length - 1) / (MAX_CURVE_POINTS - 1)
  const out: EquityPoint[] = []
  for (let i = 0; i < MAX_CURVE_POINTS; i++) {
    const point = curve[Math.round(i * step)]
    if (point) out.push(point)
  }
  return out
}

const abs = (value: bigint): bigint => (value < 0n ? -value : value)

/** Run a strategy over a bar series. Pure: same input, same output, every time. */
export function run(input: RunInput): RunResult {
  const { bars, strategyId, params, timeframe, asset, startCash, feeBps, slippageBps, seed } = input

  // No runtime state: a backtest sees the whole series in one pass, so every accumulator starts
  // empty and every bar is evaluated.
  const { signals } = compileSignals(strategyId, params, bars)
  const random = seededRandom(seed)

  let cash = startCash
  let units = 0n
  let costBasis = 0n
  let feesPaid = 0n
  let barsHeld = 0

  const fills: SimulatedFill[] = []
  const curve: EquityPoint[] = []

  // The benchmark buys at the same first fill price the strategy could have got, slippage and fee
  // included, so the comparison is like for like.
  const second = bars[1]
  const firstBar = bars[0]
  const holdBasis = second ? second.o : (firstBar?.c ?? 0n)
  const holdEntry = holdBasis > 0n ? slippedPrice(holdBasis, slippageBps, 'buy') : 0n
  const holdUnits =
    holdEntry > 0n ? unitsForCents(startCash - applyBps(startCash, feeBps), asset, holdEntry) : 0n

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i] as Bar

    // Act on the PREVIOUS bar's signal, at this bar's open.
    const signal = i > 0 ? signals[i - 1] : undefined
    if (signal && signal.target !== null) {
      const held = valueInCents(units, asset, bar.o)
      const openEquity = cash + held
      const desired = (openEquity * BigInt(signal.target)) / BPS_SCALE
      const delta = desired - held

      if (openEquity > 0n && abs(delta) * BPS_SCALE >= MIN_REBALANCE_BPS * openEquity) {
        // Drawn once per acted-on rebalance, so the sequence of draws is a function of the input
        // series and the rules alone — never of how many bars happened to be in the window.
        const jitter = jitterBps(random, EXECUTION_JITTER_BPS)
        const effectiveSlippage = Math.max(0, slippageBps + jitter)

        if (delta > 0n) {
          // The fee comes out of the same cash as the notional. Spending all of it and paying the
          // fee on top is how an account goes quietly negative — the frozen engine caps the notional
          // for the same reason at `backtest.ts`.
          const affordable = (cash * BPS_SCALE) / (BPS_SCALE + BigInt(feeBps))
          const notional = delta < affordable ? delta : affordable
          const price = slippedPrice(bar.o, effectiveSlippage, 'buy')
          const bought = notional > 0n ? unitsForCents(notional, asset, price) : 0n
          if (bought > 0n) {
            const fee = applyBps(notional, feeBps)
            cash -= notional + fee
            units += bought
            costBasis += notional
            feesPaid += fee
            fills.push({
              t: bar.t,
              side: 'buy',
              priceScaled: price,
              qty: bought,
              notionalUsdCents: notional,
              feeUsdCents: fee,
              reason: signal.reason,
            })
          }
        } else {
          const price = slippedPrice(bar.o, effectiveSlippage, 'sell')
          const wanted = price > 0n ? unitsForCents(-delta, asset, price) : 0n
          const sold = wanted < units ? wanted : units
          if (sold > 0n) {
            const notional = valueInCents(sold, asset, price)
            const fee = applyBps(notional, feeBps)
            // Average cost basis: the position is fungible, so a partial exit realises a
            // proportional slice of the cost, not FIFO lots. Computed in bigint, so the slice and
            // the remainder always sum back to the whole — a float here leaks a cent per exit and
            // the leak is what a reconciliation eventually finds.
            const released = (costBasis * sold) / units
            cash += notional - fee
            units -= sold
            costBasis -= released
            feesPaid += fee
            fills.push({
              t: bar.t,
              side: 'sell',
              priceScaled: price,
              qty: sold,
              notionalUsdCents: notional,
              feeUsdCents: fee,
              pnlUsdCents: notional - fee - released,
              reason: signal.reason,
            })
          }
        }
      }
    }

    if (units > 0n) barsHeld++
    curve.push({
      t: bar.t,
      equity: cash + valueInCents(units, asset, bar.c),
      hold: valueInCents(holdUnits, asset, bar.c),
      priceScaled: bar.c,
    })
  }

  const metrics = computeMetrics({
    curve,
    fills,
    timeframe,
    startEquity: startCash,
    barsHeld,
    barsTotal: bars.length,
    feesPaidUsdCents: feesPaid,
  })

  const last = bars[bars.length - 1]
  const result = {
    metrics,
    fills,
    equity: decimate(curve),
    from: firstBar?.t ?? 0,
    to: last?.t ?? 0,
  }
  return { ...result, digest: digestOf(result) }
}

/**
 * The digest.
 *
 * Over the DECIMATED curve and the full fill list — i.e. over exactly what is stored and served,
 * because a digest of something the caller never sees proves nothing to the caller. `bigint` is
 * serialised as a decimal string and object keys are sorted, so the hash cannot change because a
 * field was reordered in a refactor.
 */
export function digestOf(result: Omit<RunResult, 'digest'>): string {
  return createHash('sha256').update(canonicalise(result)).digest('hex')
}

function canonicalise(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'bigint') return `"${amountTo(value)}"`
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(',')}}`
}

/** The stored, JSON-safe shape of a result. Amounts become decimal strings; nothing becomes a float. */
export function serialiseResult(result: RunResult): Record<string, unknown> {
  return JSON.parse(canonicalise({ metrics: result.metrics, fills: result.fills, equity: result.equity })) as Record<
    string,
    unknown
  >
}
