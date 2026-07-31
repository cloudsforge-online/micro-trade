/**
 * Technical indicators.
 *
 * **Ported from `crucible/services/crucible/src/engine/indicators.ts`, essentially unchanged.**
 * That file is correct, well argued and has no money in it, so rewriting it would have been
 * churn — the port changes the input type (scaled integers, converted once at the boundary) and
 * nothing else. Its original comments are kept because they are the reason the code is shaped this
 * way.
 *
 * Every function returns an array the SAME LENGTH as its input, with `null` for each bar inside the
 * indicator's warm-up window. Keeping the arrays aligned means a strategy can always index by bar
 * number, which is the single easiest place to introduce an off-by-one that silently shifts every
 * signal one bar into the future — i.e. lets the backtest see tomorrow.
 *
 * ## Why these take `number` when the rest of the service is `bigint`
 *
 * An indicator is a **statistic**, not an amount. Nobody is paid an RSI, and a moving average is
 * not a balance. Doing an EMA in fixed point would buy no precision anybody can spend and would
 * lose the standard definitions the catalogue's defaults are calibrated against.
 *
 * The conversion is exact and the determinism survives it. A price scaled by `RATE_SCALE` is an
 * integer below 2^53 for any price under ~9 billion USD, so `Number(scaled)` is lossless; and IEEE
 * 754 is deterministic for a fixed sequence of operations, so the same input array produces the
 * same output array bit for bit on every run. What must not happen is a float reaching an *amount*,
 * and it cannot: a strategy's output is integer basis points. See `src/money.ts`.
 */

/** One bar. Prices are USD per whole unit at `RATE_SCALE`; `t` is the bar's OPEN time in seconds. */
export interface Bar {
  readonly t: number
  readonly o: bigint
  readonly h: bigint
  readonly l: bigint
  readonly c: bigint
  readonly v: bigint
}

export type Series = (number | null)[]

/**
 * The one boundary crossing, in one place.
 *
 * Exported so a test can assert it is exact rather than trusting the paragraph above.
 */
export function toIndicatorSpace(values: readonly bigint[]): number[] {
  return values.map((value) => Number(value))
}

/** Simple moving average. */
export function sma(values: readonly number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null)
  if (period < 1 || values.length < period) return out
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i] as number
    if (i >= period) sum -= values[i - period] as number
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

/**
 * Exponential moving average, seeded with the SMA of the first `period` bars.
 *
 * Seeding from the first value instead makes the early series depend heavily on a single bar, which
 * shifts every backtest result by an amount that changes with the start date.
 */
export function ema(values: readonly number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null)
  if (period < 1 || values.length < period) return out
  const k = 2 / (period + 1)
  let seed = 0
  for (let i = 0; i < period; i++) seed += values[i] as number
  let prev = seed / period
  out[period - 1] = prev
  for (let i = period; i < values.length; i++) {
    prev = (values[i] as number) * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

/**
 * Wilder's RSI. Uses Wilder smoothing (not a simple average of gains), which is what every charting
 * package draws — a plain average gives visibly different levels and would make the catalogue's
 * oversold/overbought defaults wrong.
 */
export function rsi(values: readonly number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null)
  if (period < 1 || values.length <= period) return out
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const change = (values[i] as number) - (values[i - 1] as number)
    if (change >= 0) gain += change
    else loss -= change
  }
  let avgGain = gain / period
  let avgLoss = loss / period
  // A flat series has no losses at all; without this guard the division below is 0/0 and every bar
  // comes out NaN rather than the neutral 100.
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  for (let i = period + 1; i < values.length; i++) {
    const change = (values[i] as number) - (values[i - 1] as number)
    const up = change > 0 ? change : 0
    const down = change < 0 ? -change : 0
    avgGain = (avgGain * (period - 1) + up) / period
    avgLoss = (avgLoss * (period - 1) + down) / period
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return out
}

export interface Macd {
  readonly macd: Series
  readonly signal: Series
  readonly histogram: Series
}

export function macd(values: readonly number[], fast: number, slow: number, signalPeriod: number): Macd {
  const fastEma = ema(values, fast)
  const slowEma = ema(values, slow)
  const line: Series = values.map((_, i) => {
    const f = fastEma[i]
    const s = slowEma[i]
    return f === null || f === undefined || s === null || s === undefined ? null : f - s
  })
  // The signal EMA runs over the MACD line, which does not exist until the slow EMA does. Feeding
  // the nulls in as zeroes would drag the signal toward zero for the whole warm-up and fake a
  // crossover on the first real bar.
  const firstReal = line.findIndex((v) => v !== null)
  const signal: Series = new Array(values.length).fill(null)
  if (firstReal >= 0) {
    const dense = line.slice(firstReal).map((v) => v as number)
    const signalDense = ema(dense, signalPeriod)
    for (let i = 0; i < signalDense.length; i++) signal[firstReal + i] = signalDense[i] ?? null
  }
  const histogram: Series = values.map((_, i) => {
    const m = line[i]
    const s = signal[i]
    return m === null || m === undefined || s === null || s === undefined ? null : m - s
  })
  return { macd: line, signal, histogram }
}

export interface Bands {
  readonly middle: Series
  readonly upper: Series
  readonly lower: Series
}

export function bollinger(values: readonly number[], period: number, deviations: number): Bands {
  const middle = sma(values, period)
  const upper: Series = new Array(values.length).fill(null)
  const lower: Series = new Array(values.length).fill(null)
  for (let i = period - 1; i < values.length; i++) {
    const mean = middle[i]
    if (mean === null || mean === undefined) continue
    let variance = 0
    for (let j = i - period + 1; j <= i; j++) variance += ((values[j] as number) - mean) ** 2
    const sd = Math.sqrt(variance / period)
    upper[i] = mean + sd * deviations
    lower[i] = mean - sd * deviations
  }
  return { middle, upper, lower }
}

/** Wilder's Average True Range. True range accounts for gaps; high-low does not. */
export function atr(bars: readonly Bar[], period: number): Series {
  const out: Series = new Array(bars.length).fill(null)
  if (bars.length <= period || period < 1) return out
  const first = bars[0] as Bar
  const tr: number[] = new Array(bars.length).fill(0)
  tr[0] = Number(first.h - first.l)
  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i] as Bar
    const prevClose = (bars[i - 1] as Bar).c
    const a = bar.h - bar.l
    const b = bar.h - prevClose
    const c = bar.l - prevClose
    // The absolute values are taken in bigint, before the conversion, so a large gap cannot lose a
    // low bit on the way through a double and then be compared against one that did not.
    tr[i] = Number(max3(a, b < 0n ? -b : b, c < 0n ? -c : c))
  }
  let sum = 0
  for (let i = 1; i <= period; i++) sum += tr[i] as number
  let prev = sum / period
  out[period] = prev
  for (let i = period + 1; i < bars.length; i++) {
    prev = (prev * (period - 1) + (tr[i] as number)) / period
    out[i] = prev
  }
  return out
}

function max3(a: bigint, b: bigint, c: bigint): bigint {
  const ab = a > b ? a : b
  return ab > c ? ab : c
}

/**
 * Highest value of the PRECEDING `period` bars, excluding the current one.
 *
 * Exclusive on purpose: a Donchian breakout asks "did this close exceed the prior range?".
 * Including the current bar makes its own high part of the channel, so the close can never exceed
 * it and the rule never fires.
 */
export function highestPrior(values: readonly number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null)
  if (period < 1) return out
  for (let i = period; i < values.length; i++) {
    let best = -Infinity
    for (let j = i - period; j < i; j++) if ((values[j] as number) > best) best = values[j] as number
    out[i] = best
  }
  return out
}

/** Lowest value of the preceding `period` bars, excluding the current one. */
export function lowestPrior(values: readonly number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null)
  if (period < 1) return out
  for (let i = period; i < values.length; i++) {
    let worst = Infinity
    for (let j = i - period; j < i; j++) if ((values[j] as number) < worst) worst = values[j] as number
    out[i] = worst
  }
  return out
}
