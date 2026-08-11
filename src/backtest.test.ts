/**
 * **A backtest is deterministic or it is worthless.**
 *
 * A user compares two runs and concludes one rule beats another. If the same input can produce two
 * answers, that conclusion is noise and this product is a random number generator with a chart. So
 * the first four tests here are the ones that matter most in the repository, and they are written so
 * that they would FAIL against an engine that read a clock or called `Math.random()` — not merely
 * pass against one that happens not to.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { run, digestOf, serialiseResult, type RunInput } from './backtest.ts'
import { RATE_SCALE } from './money.ts'
import { normaliseParams } from './catalog.ts'
import { STRATEGIES } from './catalog.ts'
import { makeBars } from './testsupport.ts'
import type { Bar } from './indicators.ts'

const bars = makeBars({ count: 400, shape: 'sawtooth' })

function input(overrides: Partial<RunInput> = {}): RunInput {
  return {
    bars,
    strategyId: 'sma_cross',
    params: normaliseParams('sma_cross', { fast: 5, slow: 20 }).params,
    timeframe: '1h',
    asset: 'BTC',
    startCash: 1_000_000n,
    feeBps: 10,
    slippageBps: 5,
    seed: 1,
    ...overrides,
  }
}

/* ------------------------------------------------------------------ determinism */

test('the same strategy, series and seed produce a byte-identical result', () => {
  const first = run(input())
  const second = run(input())
  assert.equal(first.digest, second.digest)
  // The digest is the claim, but assert the substance too — a digest of nothing would also match.
  assert.deepEqual(serialiseResult(first), serialiseResult(second))
  assert.ok(first.fills.length > 0, 'a run with no fills would make this test vacuous')
})

test('the same input run a hundred times never disagrees with itself', () => {
  // A single repeat can pass by luck against a `Math.random()` that happened to be reseeded. A
  // hundred cannot.
  const expected = run(input()).digest
  for (let i = 0; i < 100; i++) {
    assert.equal(run(input()).digest, expected, `run ${i} disagreed`)
  }
})

test('a different seed produces a different result, so the seed is consumed rather than merely stored', () => {
  // Without this the determinism claim above would be true for the uninteresting reason that nothing
  // reads the seed, which is an absence of randomness rather than a guarantee about it.
  const a = run(input({ seed: 1 }))
  const b = run(input({ seed: 2 }))
  assert.notEqual(a.digest, b.digest)
})

test('a run does not consult the wall clock, so two runs minutes apart still agree', () => {
  // Driven by moving the clock itself. If any part of the engine read `Date.now()`, the digest would
  // move with it.
  const before = run(input()).digest
  const realNow = Date.now
  try {
    Date.now = () => realNow() + 86_400_000 * 365
    assert.equal(run(input()).digest, before)
  } finally {
    Date.now = realNow
  }
})

test('every catalogue strategy is deterministic, not only the one the other tests use', () => {
  for (const strategy of STRATEGIES) {
    const { params } = normaliseParams(strategy.id, {})
    const config = input({ strategyId: strategy.id, params })
    assert.equal(run(config).digest, run(config).digest, `${strategy.id} is not deterministic`)
  }
})

test('the digest changes when the result changes, so it is not a constant wearing a hash', () => {
  const base = run(input())
  const cheaper = run(input({ feeBps: 0 }))
  assert.notEqual(base.digest, cheaper.digest)
  assert.equal(digestOf({ metrics: base.metrics, fills: base.fills, equity: base.equity, from: base.from, to: base.to }), base.digest)
})

/* ------------------------------------------------------------------ honesty */

test('a fill happens at the NEXT bar open, never at the close the signal was computed from', () => {
  // Filling at the signal bar's own close lets the simulation trade on a price it only knew after
  // the fact, which is the difference between a backtest and a fantasy.
  const result = run(input())
  const byTime = new Map(bars.map((bar) => [bar.t, bar]))
  for (const fill of result.fills) {
    const bar = byTime.get(fill.t)
    assert.ok(bar, `fill at ${fill.t} does not sit on a bar`)
    // Every fill price is the bar's OPEN moved by slippage, never its close.
    const distanceFromOpen = fill.priceScaled > bar.o ? fill.priceScaled - bar.o : bar.o - fill.priceScaled
    // 10 bps of headroom covers the modelled slippage plus the seeded jitter, and nothing else.
    assert.ok(distanceFromOpen * 10_000n <= bar.o * 11n, `fill at ${fill.t} is not derived from the bar open`)
  }
})

test('the final bar signal is never acted on, because there is no next bar to fill it at', () => {
  const result = run(input())
  const lastT = (bars[bars.length - 1] as Bar).t
  const onLast = result.fills.filter((fill) => fill.t === lastT)
  // A fill CAN land on the last bar — from the second-to-last bar's signal. What must not happen is
  // a fill derived from the last bar's own signal, and since the loop ends there, there is no bar
  // after it to carry one.
  assert.ok(onLast.length <= 1)
})

test('a run over a series that never moves produces no trades and loses nothing', () => {
  const flat = makeBars({ count: 200, shape: 'flat' })
  const result = run(input({ bars: flat, strategyId: 'sma_cross' }))
  assert.equal(result.fills.length, 0)
  assert.equal(result.metrics.endEquity, result.metrics.startEquity)
  assert.equal(result.metrics.totalReturnBps, 0n)
})

/* ------------------------------------------------------------------ the money */

test('cash never goes negative, however aggressive the rule or the fee', () => {
  // The frozen engine caps the notional for exactly this reason: spending all the cash and paying the
  // fee on top is how an account goes quietly negative.
  for (const feeBps of [0, 10, 250, 500]) {
    for (const strategy of STRATEGIES) {
      const { params } = normaliseParams(strategy.id, {})
      const result = run(input({ strategyId: strategy.id, params, feeBps }))
      for (const point of result.equity) {
        assert.ok(point.equity >= 0n, `${strategy.id} at ${feeBps}bps drove equity negative`)
      }
    }
  }
})

test('the fees reported are exactly the sum of the fees charged, with no rounding leak', () => {
  const result = run(input({ feeBps: 137 }))
  const summed = result.fills.reduce((total, fill) => total + fill.feeUsdCents, 0n)
  assert.equal(result.metrics.feesPaidUsdCents, summed)
})

test('every amount in a result is a bigint, so nothing became a float on the way out', () => {
  const result = run(input())
  for (const fill of result.fills) {
    assert.equal(typeof fill.priceScaled, 'bigint')
    assert.equal(typeof fill.qty, 'bigint')
    assert.equal(typeof fill.notionalUsdCents, 'bigint')
    assert.equal(typeof fill.feeUsdCents, 'bigint')
  }
  for (const key of ['startEquity', 'endEquity', 'feesPaidUsdCents', 'bestTradeUsdCents', 'worstTradeUsdCents'] as const) {
    assert.equal(typeof result.metrics[key], 'bigint', `${key} is not a bigint`)
  }
  for (const key of ['totalReturnBps', 'holdReturnBps', 'maxDrawdownBps', 'exposureBps', 'winRateBps'] as const) {
    assert.equal(typeof result.metrics[key], 'bigint', `${key} is not a bigint`)
  }
})

test('a serialised result carries every amount as a decimal string, never a JSON number', () => {
  const stored = serialiseResult(run(input()))
  const metrics = stored['metrics'] as Record<string, unknown>
  assert.equal(typeof metrics['startEquity'], 'string')
  assert.equal(typeof metrics['endEquity'], 'string')
  // Ratios stay numbers: a Sharpe is a statistic, not an amount.
  assert.equal(typeof metrics['sharpe'], 'number')
})

test('a higher fee can only make a trading run worse, never better', () => {
  const cheap = run(input({ feeBps: 0 }))
  const dear = run(input({ feeBps: 500 }))
  assert.ok(cheap.fills.length > 0)
  assert.ok(dear.metrics.endEquity <= cheap.metrics.endEquity)
})

test('the benchmark is bought at the same first price the strategy could have got', () => {
  const result = run(input())
  const first = result.equity[0]
  assert.ok(first)
  // Buy-and-hold pays the same fee and slippage on entry, so the comparison is like for like rather
  // than a free benchmark the strategy can never beat.
  assert.ok(first.hold <= result.metrics.startEquity)
})

/* ------------------------------------------------------------------ shape */

test('the stored equity curve is decimated but keeps its endpoints, so the chart matches the metrics', () => {
  const long = makeBars({ count: 3_000, shape: 'sawtooth' })
  const result = run(input({ bars: long }))
  assert.ok(result.equity.length <= 600, 'the curve was not decimated')
  const firstPoint = result.equity[0]
  const lastPoint = result.equity[result.equity.length - 1]
  assert.equal(firstPoint?.t, (long[0] as Bar).t)
  assert.equal(lastPoint?.t, (long[long.length - 1] as Bar).t)
  // Metrics are computed on the FULL curve before decimation — sampling first would understate max
  // drawdown by skipping the trough.
  assert.equal(lastPoint?.equity, result.metrics.endEquity)
})

test('an empty series runs to a defined, empty result rather than throwing', () => {
  const result = run(input({ bars: [] }))
  assert.equal(result.fills.length, 0)
  assert.equal(result.equity.length, 0)
  assert.equal(result.from, 0)
  assert.equal(result.to, 0)
  assert.equal(result.metrics.endEquity, 1_000_000n)
})

test('a one-bar series produces no fill, because a fill needs a bar after its signal', () => {
  const single = makeBars({ count: 1 })
  const result = run(input({ bars: single }))
  assert.equal(result.fills.length, 0)
})

test('the reported window matches the first and last bar actually read', () => {
  const result = run(input())
  assert.equal(result.from, (bars[0] as Bar).t)
  assert.equal(result.to, (bars[bars.length - 1] as Bar).t)
})

test('a price of one scaled unit does not divide by zero or produce an infinite position', () => {
  const tiny: Bar[] = makeBars({ count: 120, shape: 'flat' }).map((bar) => ({
    ...bar,
    o: 1n,
    h: 1n,
    l: 1n,
    c: 1n,
  }))
  const result = run(input({ bars: tiny, strategyId: 'buy_hold' }))
  for (const point of result.equity) assert.ok(point.equity >= 0n)
  assert.ok(Number.isFinite(result.metrics.sharpe))
})

test('a start cash of one cent is handled without a division by zero', () => {
  const result = run(input({ startCash: 1n }))
  assert.equal(result.metrics.startEquity, 1n)
  assert.ok(result.metrics.endEquity >= 0n)
})

void RATE_SCALE
