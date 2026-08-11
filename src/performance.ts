/**
 * Performance reporting.
 *
 * **Ported from `crucible/services/crucible/src/engine/metrics.ts`**, with the money/statistic split
 * made explicit, because the frozen version does not have one and it cost it a bug it documents at
 * `crucible/services/crucible/src/engine/metrics.ts`: profit factor was reported in DOLLARS
 * for a while and "rendered as a profit factor of 3067 next to ratios of 1.2". A number whose unit
 * is not in its type is a number that will eventually be printed in the wrong one.
 *
 * So, here:
 *
 *   * **Amounts are `bigint` US cents.** `startEquity`, `endEquity`, `feesPaid`, `bestTrade`,
 *     `worstTrade`. These are money and are exact.
 *   * **Proportions are `bigint` basis points.** `totalReturn`, `holdReturn`, `maxDrawdown`,
 *     `winRate`, `exposure`, `profitFactor`. A proportion of an exact amount is exactly computable
 *     and there is no reason to round it into a float — doing so is what let a 0.1% drawdown and a
 *     10% one differ by a rounding step in the frozen version's JSON.
 *   * **Ratios of volatilities are `number`.** `sharpe`, `sortino`, `calmar`, `cagr`. These involve
 *     a square root and a fractional power; they are statistics about a distribution, not amounts,
 *     and nobody is paid a Sharpe.
 *
 * The one arithmetic rule that matters: **no proportion is ever computed from a float**. Every bps
 * figure below divides two bigints. The frozen version computes max drawdown as
 * `(peak - value) / peak` in doubles (`metrics.ts`), which for a large equity and a small fall
 * loses the fall entirely.
 */

import { BPS_SCALE } from './money.ts'
import { TIMEFRAME_SECONDS, type Timeframe } from './catalog.ts'

const SECONDS_PER_YEAR = 31_557_600

/**
 * A signed proportion in basis points, exactly.
 *
 * BigInt division truncates toward zero, which is what is wanted on both signs: a gain is never
 * rounded up and a loss is never rounded down, so neither direction is flattered.
 */
export function ratioBps(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) return 0n
  return (numerator * BPS_SCALE) / denominator
}

export interface EquityPoint {
  readonly t: number
  readonly equity: bigint
  /** What buy-and-hold would have been worth, so the comparison is like for like. */
  readonly hold: bigint
  readonly priceScaled: bigint
}

export type FillSide = 'buy' | 'sell'

export interface SimulatedFill {
  readonly t: number
  readonly side: FillSide
  readonly priceScaled: bigint
  /** Base-asset smallest units. */
  readonly qty: bigint
  readonly notionalUsdCents: bigint
  readonly feeUsdCents: bigint
  /** Realised profit on a sell, in US cents. Absent on a buy — a buy realises nothing. */
  readonly pnlUsdCents?: bigint
  readonly reason: string
}

export interface BacktestMetrics {
  readonly startEquity: bigint
  readonly endEquity: bigint
  readonly totalReturnBps: bigint
  readonly holdReturnBps: bigint
  readonly maxDrawdownBps: bigint
  readonly exposureBps: bigint
  readonly winRateBps: bigint
  /** Gross profit over gross loss, in bps. 10000 is break-even. See the note below on zero. */
  readonly profitFactorBps: bigint
  readonly feesPaidUsdCents: bigint
  readonly bestTradeUsdCents: bigint
  readonly worstTradeUsdCents: bigint
  readonly trades: number
  readonly wins: number
  readonly losses: number
  readonly cagr: number
  readonly sharpe: number
  readonly sortino: number
  readonly calmar: number
}

export interface MetricsInput {
  readonly curve: readonly EquityPoint[]
  readonly fills: readonly SimulatedFill[]
  readonly timeframe: Timeframe
  readonly startEquity: bigint
  /** Bars spent holding a position, over bars evaluated. */
  readonly barsHeld: number
  readonly barsTotal: number
  readonly feesPaidUsdCents: bigint
}

/**
 * Ratios are annualised from the bar interval, so a Sharpe computed on 5-minute bars is comparable
 * with one computed on daily bars. That comparison is only ever approximate — high-frequency returns
 * are far from normal — but an un-annualised Sharpe is not comparable with anything at all.
 */
function annualisationFactor(timeframe: Timeframe): number {
  return Math.sqrt(SECONDS_PER_YEAR / TIMEFRAME_SECONDS[timeframe])
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

function stdev(values: readonly number[], from: number): number {
  if (values.length < 2) return 0
  let variance = 0
  for (const v of values) variance += (v - from) ** 2
  return Math.sqrt(variance / (values.length - 1))
}

/**
 * Largest peak-to-trough fall, as a positive proportion of the peak, in basis points.
 *
 * In bigint, deliberately. This is the one metric a user acts on — it is the answer to "how bad did
 * it get" — and computing it in doubles over a large equity is how a real fall rounds to zero.
 */
export function maxDrawdownBps(equity: readonly bigint[]): bigint {
  let peak = 0n
  let worst = 0n
  for (const value of equity) {
    if (value > peak) peak = value
    if (peak > 0n) {
      const fall = ratioBps(peak - value, peak)
      if (fall > worst) worst = fall
    }
  }
  return worst
}

export function computeMetrics(input: MetricsInput): BacktestMetrics {
  const { curve, fills, timeframe, startEquity, barsHeld, barsTotal, feesPaidUsdCents } = input
  const equity = curve.map((p) => p.equity)
  const endEquity = equity.length > 0 ? (equity[equity.length - 1] as bigint) : startEquity

  const first = curve[0]
  const last = curve[curve.length - 1]
  const holdStart = first ? first.hold : startEquity
  const holdEnd = last ? last.hold : startEquity

  // Bar-over-bar simple returns. Log returns would be marginally better behaved, but every reference
  // Sharpe a user might compare against uses simple ones.
  //
  // These are the one place a proportion becomes a float, and it is correct: they are the input to a
  // standard deviation, which is not an amount. The equity values they are derived FROM are exact.
  const returns: number[] = []
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1] as bigint
    if (prev > 0n) returns.push(Number(ratioBps(equity[i] as bigint, prev)) / 10_000 - 1)
  }

  const factor = annualisationFactor(timeframe)
  const avg = mean(returns)
  const vol = stdev(returns, avg)
  const sharpe = vol > 0 ? (avg / vol) * factor : 0

  // Sortino punishes only downside deviation, measured against a zero target rather than the mean —
  // otherwise a strategy that is reliably bad scores well for being reliable.
  const downside = returns.filter((r) => r < 0)
  const downsideDev = downside.length > 0 ? Math.sqrt(mean(downside.map((r) => r * r))) : 0
  const sortino = downsideDev > 0 ? (avg / downsideDev) * factor : 0

  const drawdown = maxDrawdownBps(equity)

  const spanSeconds =
    curve.length > 1 && first && last ? last.t - first.t : TIMEFRAME_SECONDS[timeframe]
  const years = spanSeconds / SECONDS_PER_YEAR
  const cagr =
    years > 0 && startEquity > 0n && endEquity > 0n
      ? (Number(endEquity) / Number(startEquity)) ** (1 / years) - 1
      : 0

  const calmar = drawdown > 0n ? cagr / (Number(drawdown) / 10_000) : 0

  const closed = fills.filter((f) => f.pnlUsdCents !== undefined)
  const wins = closed.filter((f) => (f.pnlUsdCents ?? 0n) > 0n)
  const losses = closed.filter((f) => (f.pnlUsdCents ?? 0n) < 0n)
  const grossProfit = wins.reduce((sum, f) => sum + (f.pnlUsdCents ?? 0n), 0n)
  const grossLoss = losses.reduce((sum, f) => sum - (f.pnlUsdCents ?? 0n), 0n)
  const pnls = closed.map((f) => f.pnlUsdCents ?? 0n)

  return {
    startEquity,
    endEquity,
    totalReturnBps: ratioBps(endEquity - startEquity, startEquity),
    holdReturnBps: ratioBps(holdEnd - holdStart, holdStart),
    maxDrawdownBps: drawdown,
    exposureBps: barsTotal > 0 ? ratioBps(BigInt(barsHeld), BigInt(barsTotal)) : 0n,
    winRateBps: closed.length > 0 ? ratioBps(BigInt(wins.length), BigInt(closed.length)) : 0n,
    // Profit factor is gross profit over gross loss, so a run with no losing trade has no defined
    // value — and JSON cannot carry Infinity. Zero is the sentinel; a reader tells the two cases
    // apart with `losses`, which is right here.
    profitFactorBps: grossLoss > 0n ? ratioBps(grossProfit, grossLoss) : 0n,
    feesPaidUsdCents,
    bestTradeUsdCents: pnls.length > 0 ? pnls.reduce((a, b) => (b > a ? b : a)) : 0n,
    worstTradeUsdCents: pnls.length > 0 ? pnls.reduce((a, b) => (b < a ? b : a)) : 0n,
    trades: fills.length,
    wins: wins.length,
    losses: losses.length,
    cagr,
    sharpe,
    sortino,
    calmar,
  }
}
