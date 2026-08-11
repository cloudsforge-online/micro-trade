/**
 * The pure arithmetic and the pure engine pieces. No database, no clock, no socket.
 *
 * These are the tests that hold down "no float anywhere in money" and "an indicator is aligned to
 * its bars". Both are properties nothing else can check: a rounding leak does not throw, and an
 * off-by-one in an indicator makes a losing strategy look profitable rather than making anything
 * fail.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BPS_SCALE,
  CENTS_PER_USD,
  MIN_FEE_CENTS,
  RATE_SCALE,
  amountFrom,
  amountTo,
  applyBps,
  applyBpsUp,
  equityOf,
  formatPrice,
  parsePrice,
  performanceFee,
  slippedPrice,
  toTargetBps,
  unitsForCents,
  valueInCents,
} from './money.ts'
import { jitterBps, seededRandom, fixedClock } from './rng.ts'
import { atr, bollinger, ema, highestPrior, lowestPrior, macd, rsi, sma, toIndicatorSpace } from './indicators.ts'
import { STRATEGIES, TIMEFRAME_SECONDS, findStrategy, isStrategyId, isTimeframe, normaliseParams } from './catalog.ts'
import { compileSignals } from './strategies.ts'
import { computeMetrics, maxDrawdownBps, ratioBps } from './performance.ts'
import { fillPostings, performanceFeePostings, settlementIdempotencyKey, fillIdempotencyKey } from './ledgerclient.ts'
import { parseAccountSubject } from '@cloudsforge/contracts-money'
import { requestFingerprint } from './idempotency.ts'
import { assertIngestable, stalenessIntervals, BarRejectedError } from './series.ts'
import { makeBars } from './testsupport.ts'
import { renameStoredMoneyKeys } from './backtests.ts'
import type { Bar } from './indicators.ts'

/* ------------------------------------------------------------------ money */

test('a fee rounds down, so the fraction of a cent is never taken from the customer', () => {
  // 999 × 15% = 149.85. The house eats the .85 rather than rounding it onto the bill.
  assert.equal(applyBps(999n, 1_500), 149n)
  assert.equal(applyBpsUp(999n, 1_500), 150n)
})

test('a zero-rate charge is zero in both rounding directions, not one cent', () => {
  assert.equal(applyBps(1_000_000n, 0), 0n)
  assert.equal(applyBpsUp(1_000_000n, 0), 0n)
})

test('applying basis points to a negative amount is refused rather than silently signed', () => {
  assert.throws(() => applyBps(-1n, 100), RangeError)
})

test('slippage moves the price against the trader on both sides, never in their favour', () => {
  const price = 30_000n * RATE_SCALE
  const buy = slippedPrice(price, 50, 'buy')
  const sell = slippedPrice(price, 50, 'sell')
  assert.ok(buy > price, 'a buyer pays more')
  assert.ok(sell < price, 'a seller receives less')
  // Symmetric around the mid, so the spread is not accidentally widened on one leg.
  assert.equal(buy - price, price - sell)
})

test('a holding is valued down, so a portfolio never claims a cent the market would not pay', () => {
  // 1 satoshi of BTC at $30,000 is 0.0003 cents, which is zero whole cents.
  assert.equal(valueInCents(1n, 'BTC', 30_000n * RATE_SCALE), 0n)
  // A whole BTC at $30,000 is 3,000,000 cents exactly — $30,000.00, at 100 cents per USD.
  assert.equal(valueInCents(100_000_000n, 'BTC', 30_000n * RATE_SCALE), 3_000_000n)
})

test('valuing a holding at a zero price is refused rather than reported as worthless', () => {
  assert.throws(() => valueInCents(100n, 'BTC', 0n), RangeError)
})

test('buying then valuing never returns more cents than were spent', () => {
  // The property that matters for a rebalance loop: round-tripping must not manufacture value, or a
  // bot could rebalance itself rich one rounding step at a time.
  const price = 27_345n * RATE_SCALE + 123_456n
  for (const spend of [1n, 7n, 999n, 100_000n, 3_000_000n]) {
    const units = unitsForCents(spend, 'BTC', price)
    assert.ok(valueInCents(units, 'BTC', price) <= spend, `round trip of ${spend} manufactured value`)
  }
})

test('equity is cash plus the marked position, and a flat bot is worth its cash', () => {
  assert.equal(equityOf(1_000n, 0n, 'BTC', 30_000n * RATE_SCALE), 1_000n)
  assert.equal(equityOf(1_000n, 100_000_000n, 'BTC', 30_000n * RATE_SCALE), 3_001_000n)
})

test('a target exposure is clamped to whole basis points inside [0, 10000]', () => {
  assert.equal(toTargetBps(0.5), 5_000)
  assert.equal(toTargetBps(-1), 0)
  assert.equal(toTargetBps(9), 10_000)
  assert.equal(toTargetBps(Number.NaN), 0)
})

test('a performance fee is zero below the high-water mark, so a recovery is never billed twice', () => {
  assert.equal(performanceFee(900n, 1_000n, 1_500), 0n)
  assert.equal(performanceFee(1_000n, 1_000n, 1_500), 0n)
})

test('a performance fee under the floor is zero, so a settlement history is not buried in noise', () => {
  // A 30-cent gain at 15% is 4.5 → 4 cents, which is under MIN_FEE_CENTS.
  assert.equal(performanceFee(1_030n, 1_000n, 1_500), 0n)
  assert.ok(performanceFee(1_040n, 1_000n, 1_500) >= MIN_FEE_CENTS)
})

/* ═════════════════════ micro-org#418: the re-denomination is the identity ═════════════════════
 *
 * micro-trade called its unit a "Shard" until SHARD was retired (`RETIRED_ASSETS`,
 * `contracts/packages/chain/src/index.ts`). It was always a US cent — the peg is fixed at 100 to
 * the dollar and SHARD carries `decimals: 0` — so the change was a rename and NOT a re-basing.
 *
 * That claim is only worth anything if something checks it. These three do, in the direction that
 * would fail if somebody ever "tidied" the arithmetic while renaming it: a re-denomination that
 * moves a single number is a bug, not a rename.
 */

test('the peg is 100 and is imported, so the identity cannot drift from contracts', () => {
  // If this is ever not 100, a Shard stopped being a cent and NOTHING in this file's claim holds —
  // including the stored columns, which were never converted. Re-read `src/money.ts` before
  // changing it; the fix is a migration, not an edit here.
  assert.equal(CENTS_PER_USD, 100n)
})

test('every figure in this service is unchanged to the digit by micro-org#418', () => {
  // The exact values that were asserted against these functions under their old names, kept as
  // literals rather than recomputed. Recomputing them would make this test agree with whatever the
  // code does today, which is the one thing it must not do.
  //
  //   valueInShards → valueInCents, unitsForShards → unitsForCents, MIN_FEE_SHARDS → MIN_FEE_CENTS
  assert.equal(valueInCents(100_000_000n, 'BTC', 30_000n * RATE_SCALE), 3_000_000n)
  assert.equal(valueInCents(1n, 'BTC', 30_000n * RATE_SCALE), 0n)
  assert.equal(equityOf(1_000n, 100_000_000n, 'BTC', 30_000n * RATE_SCALE), 3_001_000n)
  assert.equal(performanceFee(11_000n, 10_000n, 1_500), 150n)
  assert.equal(MIN_FEE_CENTS, 5n)

  // 3,000,000 of this unit is $30,000.00 — the same money "3,000,000 Shards" named. The assertion
  // is written as the conversion so that a reader can check the claim rather than take it.
  assert.equal(valueInCents(100_000_000n, 'BTC', 30_000n * RATE_SCALE) / CENTS_PER_USD, 30_000n)
})

test('a cent amount buys the same units a Shard amount bought, at the same price', () => {
  // `unitsForCents` still calls contracts-chain's `coinAmountForShards` on purpose — the peg makes
  // it the correct arithmetic, and its USD-cents replacement THROWS on a zero result where this
  // service needs `0n` to mean "nothing affordable" (see `src/money.ts`). That zero is asserted
  // here, because a swap that looked like a cleanup would turn a routine tick into an exception.
  const price = 27_345n * RATE_SCALE + 123_456n
  assert.equal(unitsForCents(0n, 'BTC', price), 0n)
  assert.equal(unitsForCents(1n, 'BTC', price), 36n, 'one cent buys 36 satoshis at $27,345.123456')
  assert.equal(unitsForCents(3_000_000n, 'BTC', 30_000n * RATE_SCALE), 100_000_000n)

  // The zero that must stay a zero rather than becoming a throw. A price high enough that a whole
  // cent does not reach one satoshi is the case `planRebalance` meets whenever a bot is nearly out
  // of cash: it reads `qty <= 0n`, records `no_signal`, and ticks on.
  assert.equal(unitsForCents(1n, 'BTC', 10n ** 20n), 0n)
})

test('a backtest stored before the rename still reports its fees, rather than a blank', () => {
  // THE DEFECT THIS EXISTS TO PREVENT. `metrics` and `trades` are jsonb written from the field
  // names, so renaming the interfaces left every already-completed run carrying the old keys. The
  // fixture below is literally what a pre-micro-org#418 row holds; if the reader is deleted this
  // test fails, and if it is not, the customer's screen shows nothing where the fee used to be.
  const stored = renameStoredMoneyKeys({
    startEquity: '1000000',
    feesPaidShards: '1500',
    bestTradeShards: '20000',
    worstTradeShards: '-8000',
    trades: 12,
  }) as Record<string, unknown>

  assert.equal(stored['feesPaidUsdCents'], '1500', 'the fee is readable under its new name')
  assert.equal(stored['bestTradeUsdCents'], '20000')
  assert.equal(stored['worstTradeUsdCents'], '-8000')
  assert.equal(stored['feesPaidShards'], undefined, 'and not under the old one as well')

  // Untouched: the value is the same digits, and every non-money key is passed straight through.
  assert.equal(stored['startEquity'], '1000000')
  assert.equal(stored['trades'], 12)

  // A fill written before the rename, which is the array element the result route serves.
  const fill = renameStoredMoneyKeys({
    side: 'sell',
    qty: '100',
    notionalShards: '3000',
    feeShards: '3',
    pnlShards: '-42',
  }) as Record<string, unknown>
  assert.equal(fill['notionalUsdCents'], '3000')
  assert.equal(fill['feeUsdCents'], '3')
  assert.equal(fill['pnlUsdCents'], '-42', 'a negative realised pnl survives, sign and all')
  assert.equal(fill['side'], 'sell')
})

test('a result written after the rename is returned unchanged, and never double-renamed', () => {
  const fresh = { feesPaidUsdCents: '99', trades: 1 }
  assert.equal(renameStoredMoneyKeys(fresh), fresh, 'the same object, not a rebuilt copy')

  // The one ambiguous row: both keys present, which only a half-finished migration could produce.
  // The NEW key wins, because it is the one this service wrote.
  const both = renameStoredMoneyKeys({ feesPaidShards: '1', feesPaidUsdCents: '2' }) as Record<string, unknown>
  assert.equal(both['feesPaidUsdCents'], '2')

  // `metrics` is null until a run completes, and null must not become an object.
  assert.equal(renameStoredMoneyKeys(null), null)
})

test('a performance fee is a rounded-down share of the gain above the mark', () => {
  assert.equal(performanceFee(11_000n, 10_000n, 1_500), 150n)
})

test('an amount read from a numeric column arrives as a bigint, whatever shape the driver used', () => {
  assert.equal(amountFrom('123456789012345678901234567890'), 123456789012345678901234567890n)
  assert.equal(amountFrom(42), 42n)
  assert.equal(amountFrom(7n), 7n)
})

test('an amount that has already lost precision as a JSON number is refused, not accepted', () => {
  assert.throws(() => amountFrom(Number.MAX_SAFE_INTEGER + 2), RangeError)
  assert.throws(() => amountFrom('12.5'), RangeError)
  assert.throws(() => amountFrom({}), RangeError)
})

test('an amount leaves as a decimal string, so a large one survives the wire', () => {
  assert.equal(amountTo(2n ** 70n), '1180591620717411303424')
})

test('a price round-trips through its decimal form without drifting', () => {
  for (const text of ['0.000001', '1', '30000.123456', '99999999.999999']) {
    assert.equal(formatPrice(parsePrice(text)), text)
  }
})

test('a price with more precision than the scale can hold is refused rather than truncated', () => {
  assert.throws(() => parsePrice('1.0000001'), RangeError)
  assert.throws(() => parsePrice('not a price'), RangeError)
})

test('a proportion in basis points truncates toward zero on both signs, flattering neither', () => {
  assert.equal(ratioBps(1n, 3n), 3_333n)
  assert.equal(ratioBps(-1n, 3n), -3_333n)
  assert.equal(ratioBps(1n, 0n), 0n)
  assert.equal(BPS_SCALE, 10_000n)
})

/* ------------------------------------------------------------------ determinism primitives */

test('the seeded generator produces the same stream for the same seed, and a different one otherwise', () => {
  const a = seededRandom(7)
  const b = seededRandom(7)
  const c = seededRandom(8)
  const first = Array.from({ length: 32 }, () => a())
  const second = Array.from({ length: 32 }, () => b())
  const third = Array.from({ length: 32 }, () => c())
  assert.deepEqual(first, second)
  assert.notDeepEqual(first, third)
})

test('every seeded draw lies in [0, 1), so it cannot produce an out-of-range jitter', () => {
  const random = seededRandom(12345)
  for (let i = 0; i < 5_000; i++) {
    const value = random()
    assert.ok(value >= 0 && value < 1, `draw ${value} is out of range`)
  }
})

test('a negative or fractional seed still produces a defined, reproducible stream', () => {
  assert.deepEqual(
    Array.from({ length: 4 }, seededRandom(-3)),
    Array.from({ length: 4 }, seededRandom(-3)),
  )
  assert.ok(Number.isFinite(seededRandom(1.5)()))
})

test('jitter stays inside its span and is a whole number of basis points', () => {
  const random = seededRandom(99)
  for (let i = 0; i < 1_000; i++) {
    const value = jitterBps(random, 5)
    assert.ok(Number.isInteger(value), 'jitter must be whole basis points')
    assert.ok(value >= -5 && value <= 5, `jitter ${value} escaped its span`)
  }
})

test('a zero jitter span produces no jitter at all rather than a rounding artefact', () => {
  assert.equal(jitterBps(seededRandom(1), 0), 0)
})

/* ------------------------------------------------------------------ indicators */

const closes = (values: number[]): number[] => values

test('a moving average is null through its warm-up, so a strategy cannot index a value that does not exist', () => {
  const out = sma(closes([1, 2, 3, 4, 5]), 3)
  assert.deepEqual(out.slice(0, 2), [null, null])
  assert.equal(out[2], 2)
  assert.equal(out[4], 4)
})

test('an indicator returns exactly one value per bar, so signals cannot shift a bar into the future', () => {
  const values = Array.from({ length: 50 }, (_, i) => 100 + i)
  for (const series of [sma(values, 10), ema(values, 10), rsi(values, 14)]) {
    assert.equal(series.length, values.length)
  }
  const { macd: line, signal, histogram } = macd(values, 12, 26, 9)
  assert.equal(line.length, values.length)
  assert.equal(signal.length, values.length)
  assert.equal(histogram.length, values.length)
})

test('an EMA is seeded from the average of its window, not from one bar', () => {
  const values = [10, 20, 30, 40, 50]
  const out = ema(values, 3)
  // (10 + 20 + 30) / 3
  assert.equal(out[2], 20)
})

test('a flat series has an RSI of 100 rather than NaN, because there is no loss to divide by', () => {
  const out = rsi(new Array(30).fill(100), 14)
  assert.equal(out[14], 100)
  assert.ok(out.every((value, i) => (i <= 13 ? value === null : value === 100)))
})

test('the MACD signal line does not exist before the MACD line does', () => {
  const values = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i) * 5)
  const { macd: line, signal } = macd(values, 12, 26, 9)
  const firstLine = line.findIndex((v) => v !== null)
  const firstSignal = signal.findIndex((v) => v !== null)
  assert.ok(firstSignal >= firstLine, 'the signal cannot start before the line it averages')
})

test('Bollinger bands sit symmetrically around their middle band', () => {
  const values = Array.from({ length: 40 }, (_, i) => 100 + (i % 7))
  const { middle, upper, lower } = bollinger(values, 20, 2)
  const m = middle[30]
  const u = upper[30]
  const l = lower[30]
  assert.ok(m != null && u != null && l != null)
  assert.ok(Math.abs((u - m) - (m - l)) < 1e-9)
})

test('a prior-window extreme excludes the current bar, or a breakout could never fire', () => {
  const values = [1, 2, 3, 10, 4]
  const high = highestPrior(values, 3)
  // At index 3 the prior three bars are 1, 2, 3 — the bar's own 10 is not in its own channel.
  assert.equal(high[3], 3)
  const low = lowestPrior(values, 3)
  assert.equal(low[3], 1)
})

test('ATR accounts for a gap between bars rather than only the bar range', () => {
  const gapped: Bar[] = [
    { t: 0, o: 100n, h: 110n, l: 90n, c: 100n, v: 0n },
    // Opens far above the previous close: the true range is the gap, not the 5-wide bar.
    { t: 1, o: 200n, h: 205n, l: 200n, c: 202n, v: 0n },
    { t: 2, o: 202n, h: 206n, l: 201n, c: 203n, v: 0n },
    { t: 3, o: 203n, h: 207n, l: 202n, c: 204n, v: 0n },
  ]
  const out = atr(gapped, 2)
  const value = out[2]
  assert.ok(value != null && value > 5, 'the gap must dominate the bar width')
})

test('converting a scaled price to indicator space is exact, so determinism survives the boundary', () => {
  const scaled = [30_000n * RATE_SCALE, 1n, 9_007_199_254_740_991n]
  const converted = toIndicatorSpace(scaled)
  converted.forEach((value, i) => assert.equal(BigInt(value), scaled[i] as bigint))
})

/* ------------------------------------------------------------------ catalogue */

test('every catalogue entry names a strategy the engine can actually evaluate', () => {
  const bars = makeBars({ count: 120, shape: 'sawtooth' })
  for (const strategy of STRATEGIES) {
    assert.ok(isStrategyId(strategy.id))
    const { params } = normaliseParams(strategy.id, {})
    const run = compileSignals(strategy.id, params, bars)
    assert.equal(run.signals.length, bars.length, `${strategy.id} did not produce one signal per bar`)
  }
})

test('every catalogue entry states a weakness, so the catalogue is not advertising', () => {
  for (const strategy of STRATEGIES) {
    assert.ok(strategy.weakness.length > 10, `${strategy.id} has no stated weakness`)
  }
})

test('a parameter outside its range is clamped and the change is reported, never applied silently', () => {
  const { params, adjusted } = normaliseParams('rsi_reversion', { period: 9_999 })
  assert.equal(params['period'], 100)
  assert.ok(adjusted.some((note) => note.includes('clamped')))
})

test('a crossover whose fast leg is slower than its slow leg is repaired, or it would never trade', () => {
  const { params, adjusted } = normaliseParams('sma_cross', { fast: 50, slow: 20 })
  assert.ok((params['slow'] as number) > (params['fast'] as number))
  assert.ok(adjusted.some((note) => note.includes('slow period raised')))
})

test('an oversold level can never end up at or above the overbought one, whatever was asked for', () => {
  // Worth stating as an invariant over the whole input space rather than one example. The catalogue's
  // own ranges (oversold <= 45, overbought >= 55) mean the clamp alone already separates them, so the
  // explicit cross-field repair in `normaliseParams` is unreachable for THIS catalogue — it is kept
  // because the ranges are data and a future edit that overlaps them would otherwise ship a rule that
  // silently never trades.
  for (const oversold of [-10, 5, 30, 45, 70, 200]) {
    for (const overbought of [-10, 20, 55, 70, 95, 200]) {
      const { params } = normaliseParams('rsi_reversion', { oversold, overbought })
      assert.ok(
        (params['overbought'] as number) > (params['oversold'] as number),
        `oversold ${oversold} / overbought ${overbought} came back unordered`,
      )
    }
  }
})

test('a missing parameter takes the catalogue default rather than undefined', () => {
  const { params } = normaliseParams('sma_cross', {})
  assert.equal(params['fast'], 20)
  assert.equal(params['slow'], 50)
})

test('an unknown strategy id is not a strategy, and an unknown timeframe is not a timeframe', () => {
  assert.equal(findStrategy('nope'), undefined)
  assert.equal(isStrategyId('nope'), false)
  assert.equal(isTimeframe('3m'), false)
  assert.equal(isTimeframe('1h'), true)
  assert.equal(TIMEFRAME_SECONDS['1h'], 3_600)
})

/* ------------------------------------------------------------------ signals */

test('a signal target is always whole basis points inside [0, 10000], so no float reaches an amount', () => {
  const bars = makeBars({ count: 200, shape: 'sawtooth' })
  for (const strategy of STRATEGIES) {
    const { params } = normaliseParams(strategy.id, {})
    for (const signal of compileSignals(strategy.id, params, bars).signals) {
      if (signal.target === null) continue
      assert.ok(Number.isInteger(signal.target), `${strategy.id} produced a fractional target`)
      assert.ok(signal.target >= 0 && signal.target <= 10_000, `${strategy.id} produced ${signal.target}`)
    }
  }
})

test('a DCA bot handed its own carried state does not re-buy the slices it already bought', () => {
  // The frozen defect: re-deriving the accumulator from a sliding window made a fresh DCA spend its
  // whole allocation at once, because the window held enough bars for every slice.
  const bars = makeBars({ count: 100, shape: 'flat' })
  const first = compileSignals('dca', { every: 7, slices: 12 }, bars, { state: {}, from: bars.length - 1 })
  assert.equal(first.state['bought'], 1, 'a first tick buys exactly one slice')

  const second = compileSignals('dca', { every: 7, slices: 12 }, bars, {
    state: first.state,
    from: bars.length - 1,
  })
  // One bar later and the interval has not elapsed, so nothing new is bought.
  assert.equal(second.state['bought'], 1)
})

test('a grid handed no state anchors at the first bar it covers, not at the window start', () => {
  const bars = makeBars({ count: 60, shape: 'falling' })
  const run = compileSignals('grid', { rungs: 4, spacing: 2 }, bars, { state: {}, from: bars.length - 1 })
  const lastBar = bars[bars.length - 1] as Bar
  assert.equal(run.state['anchor'], Number(lastBar.c))
})

test('a trailing stop remembers that it is in a position across evaluations', () => {
  const bars = makeBars({ count: 200, shape: 'rising' })
  const run = compileSignals('atr_trailing', { trend: 20, atr: 14, multiple: 3 }, bars)
  assert.equal(run.state['inPosition'], 1)
  assert.ok((run.state['peak'] as number) > 0)
})

test('buy and hold is fully invested from the first bar and never asks to sell', () => {
  const bars = makeBars({ count: 30 })
  const { signals } = compileSignals('buy_hold', {}, bars)
  assert.ok(signals.every((signal) => signal.target === 10_000))
})

test('an empty series produces no signals rather than throwing', () => {
  for (const strategy of STRATEGIES) {
    assert.deepEqual(compileSignals(strategy.id, {}, []).signals, [])
  }
})

/* ------------------------------------------------------------------ performance */

test('max drawdown is measured in exact basis points, so a small fall on a large equity survives', () => {
  // A one-cent fall on 1,000,000 is 0.0001 — which is 1 bp, and a float computation of it against a
  // large peak is where the frozen version loses it entirely.
  assert.equal(maxDrawdownBps([1_000_000n, 999_900n, 1_000_000n]), 1n)
  assert.equal(maxDrawdownBps([100n, 50n]), 5_000n)
  assert.equal(maxDrawdownBps([]), 0n)
})

test('drawdown is measured from the running peak, not from the start', () => {
  assert.equal(maxDrawdownBps([100n, 200n, 100n]), 5_000n)
})

test('a run with no losing trade reports a profit factor of zero, because it has none defined', () => {
  const metrics = computeMetrics({
    curve: [
      { t: 0, equity: 1_000n, hold: 1_000n, priceScaled: RATE_SCALE },
      { t: 3_600, equity: 1_100n, hold: 1_000n, priceScaled: RATE_SCALE },
    ],
    fills: [
      { t: 0, side: 'sell', priceScaled: RATE_SCALE, qty: 1n, notionalUsdCents: 100n, feeUsdCents: 0n, pnlUsdCents: 100n, reason: 'x' },
    ],
    timeframe: '1h',
    startEquity: 1_000n,
    barsHeld: 1,
    barsTotal: 2,
    feesPaidUsdCents: 0n,
  })
  assert.equal(metrics.profitFactorBps, 0n)
  assert.equal(metrics.losses, 0)
  assert.equal(metrics.totalReturnBps, 1_000n)
  assert.equal(metrics.exposureBps, 5_000n)
})

test('performance totals are bigint throughout, so a long run leaks no cent', () => {
  // A hundred alternating one-cent wins and losses must net to exactly zero, not to 1e-13.
  const fills = Array.from({ length: 100 }, (_, i) => ({
    t: i,
    side: 'sell' as const,
    priceScaled: RATE_SCALE,
    qty: 1n,
    notionalUsdCents: 1n,
    feeUsdCents: 0n,
    pnlUsdCents: i % 2 === 0 ? 1n : -1n,
    reason: 'x',
  }))
  const metrics = computeMetrics({
    curve: [{ t: 0, equity: 1_000n, hold: 1_000n, priceScaled: RATE_SCALE }],
    fills,
    timeframe: '1h',
    startEquity: 1_000n,
    barsHeld: 0,
    barsTotal: 100,
    feesPaidUsdCents: 0n,
  })
  assert.equal(metrics.wins, 50)
  assert.equal(metrics.losses, 50)
  assert.equal(metrics.bestTradeUsdCents, 1n)
  assert.equal(metrics.worstTradeUsdCents, -1n)
  // 50 profit over 50 loss, exactly break-even, exactly 10000 bps.
  assert.equal(metrics.profitFactorBps, 10_000n)
})

test('an empty run reports its start equity as its end equity rather than zero', () => {
  const metrics = computeMetrics({
    curve: [],
    fills: [],
    timeframe: '1d',
    startEquity: 5_000n,
    barsHeld: 0,
    barsTotal: 0,
    feesPaidUsdCents: 0n,
  })
  assert.equal(metrics.endEquity, 5_000n)
  assert.equal(metrics.totalReturnBps, 0n)
  assert.equal(metrics.sharpe, 0)
})

/* ------------------------------------------------------------------ ledger postings */

test('a buy fill balances per asset, which is the only thing the ledger will accept', () => {
  const postings = fillPostings({
    userId: ALICE_ID,
    asset: 'BTC',
    side: 'buy',
    notionalUsdCents: 1_000n,
    units: 33_000n,
    feeUsdCents: 10n,
  })
  assertBalancedPerAsset(postings)
})

test('a sell fill balances per asset too, with the directions mirrored', () => {
  const postings = fillPostings({
    userId: ALICE_ID,
    asset: 'BTC',
    side: 'sell',
    notionalUsdCents: 1_000n,
    units: 33_000n,
    feeUsdCents: 10n,
  })
  assertBalancedPerAsset(postings)
  assert.equal(postings[0]?.direction, 'debit')
  assert.equal(postings[0]?.assetCode, 'BTC')
})

test('a fill with no fee posts no fee legs at all, rather than two zero-amount ones', () => {
  const postings = fillPostings({
    userId: ALICE_ID,
    asset: 'BTC',
    side: 'buy',
    notionalUsdCents: 1_000n,
    units: 33_000n,
    feeUsdCents: 0n,
  })
  assert.equal(postings.length, 4)
})

test('a performance fee debits the user and credits platform revenue, and balances', () => {
  const postings = performanceFeePostings({ userId: ALICE_ID, amountUsdCents: 250n })
  assertBalancedPerAsset(postings)
  assert.equal(postings[1]?.account.subject, 'platform')
  assert.equal(postings[1]?.account.purpose, 'fees')
})

/**
 * Every subject the money postings name is one the ledger's grammar has — micro-org#372, the half
 * the first fix did not reach.
 *
 * ## The mutations this kills
 *
 * **One:** widening `AccountRef.subject` back to `string`. `transferPostings` spelled its escrow leg
 * `'exchange'` for the life of the order book and no compiler objected, because `string` is what a
 * subject was declared to be. Registering `EXCHANGE` fixed that ONE literal and left the other five
 * — the two `clearing` legs, `platform` twice, and the user wallets — equally free to be wrong.
 * This walks all of them past the contract's own `parseAccountSubject`, which is the function
 * micro-ledger's `ensureAccount` calls, so a subject the estate cannot read fails here rather than
 * at the far end of a money write.
 *
 * **Two:** restoring the hand-rolled `` (id) => `user:${id}` `` this file's source used to carry in
 * two copies. The contract's `userSubject` additionally refuses an id containing `:` or `|`, and
 * `accountKey` joins on `|` — so an id carrying one lets two distinct accounts collapse onto a
 * single key, which is the quietest possible way to merge two customers' balances. A local
 * one-liner has never checked for it and a `subject: string` type never could.
 *
 * Pure, so it runs in CI with no database — which is what the defect it covers never had.
 */
test('every subject a money posting names is one micro-ledger can parse', () => {
  const buy = fillPostings({ userId: ALICE_ID, asset: 'BTC', side: 'buy', notionalUsdCents: 1_000n, units: 33_000n, feeUsdCents: 10n })
  const sell = fillPostings({ userId: ALICE_ID, asset: 'BTC', side: 'sell', notionalUsdCents: 1_000n, units: 33_000n, feeUsdCents: 10n })
  const fee = performanceFeePostings({ userId: ALICE_ID, amountUsdCents: 250n })
  for (const posting of [...buy, ...sell, ...fee]) {
    assert.doesNotThrow(
      () => parseAccountSubject(posting.account.subject),
      `${posting.account.subject} is not an account subject — ensureAccount throws on it and the entry dies at the ledger`,
    )
  }
})

test('an id that would collide two accounts onto one key is refused rather than posted', () => {
  // `accountKey` joins subject and asset on `|`, and a subject is `user:<id>`, so an id carrying
  // either delimiter is one that can name somebody else's account.
  assert.throws(() => fillPostings({ userId: 'a:b', asset: 'BTC', side: 'buy', notionalUsdCents: 1n, units: 1n, feeUsdCents: 0n }), RangeError)
  assert.throws(() => performanceFeePostings({ userId: 'a|b', amountUsdCents: 1n }), RangeError)
  assert.throws(() => performanceFeePostings({ userId: '', amountUsdCents: 1n }), RangeError)
})

test('a settlement key is derived from the bot and the period, never from a random row id', () => {
  // This is the whole schema-level fix, asserted as a property of the key rather than of the row:
  // two attempts in one period must produce the same key.
  assert.equal(settlementIdempotencyKey('bot-1', 42n), settlementIdempotencyKey('bot-1', 42n))
  assert.notEqual(settlementIdempotencyKey('bot-1', 42n), settlementIdempotencyKey('bot-1', 43n))
  assert.notEqual(settlementIdempotencyKey('bot-1', 42n), settlementIdempotencyKey('bot-2', 42n))
  assert.equal(fillIdempotencyKey('f-1'), 'trade:fill:f-1')
})

/* ------------------------------------------------------------------ idempotency fingerprint */

test('a retry with a fresh correlation id is the same request, not a key reuse', () => {
  const a = requestFingerprint({ botId: 'b1', action: 'start', correlationId: 'req-1' })
  const b = requestFingerprint({ botId: 'b1', action: 'start', correlationId: 'req-2' })
  assert.equal(a, b)
})

test('a genuinely different body fingerprints differently, so a reused key is caught', () => {
  assert.notEqual(
    requestFingerprint({ botId: 'b1', action: 'start' }),
    requestFingerprint({ botId: 'b1', action: 'stop' }),
  )
})

test('field order does not change a fingerprint, so a legitimate retry is not refused', () => {
  assert.equal(
    requestFingerprint({ a: 1, b: 2, nested: { x: 1, y: 2 } }),
    requestFingerprint({ b: 2, a: 1, nested: { y: 2, x: 1 } }),
  )
})

test('an amount fingerprints as its exact decimal string, never as a float', () => {
  assert.equal(
    requestFingerprint({ amount: 2n ** 70n }),
    requestFingerprint({ amount: '1180591620717411303424' }),
  )
})

/* ------------------------------------------------------------------ bar ingest rules */

test('an unclosed bar is refused, because feeding it to a strategy shows it a price that has not happened', () => {
  const clock = fixedClock(1_700_003_600_000)
  const bar: Bar = { t: 1_700_003_600, o: 1n, h: 2n, l: 1n, c: 2n, v: 0n }
  assert.throws(() => assertIngestable(bar, '1h', clock), BarRejectedError)
})

test('a bar whose close sits outside its own range is refused rather than stored', () => {
  const clock = fixedClock(1_800_000_000_000)
  assert.throws(
    () => assertIngestable({ t: 1_700_000_400, o: 10n, h: 12n, l: 8n, c: 99n, v: 0n }, '1h', clock),
    BarRejectedError,
  )
})

test('a bar not aligned to its timeframe boundary is refused, or two series could disagree on a bar', () => {
  const clock = fixedClock(1_800_000_000_000)
  assert.throws(
    () => assertIngestable({ t: 1_700_000_401, o: 10n, h: 12n, l: 8n, c: 11n, v: 0n }, '1h', clock),
    BarRejectedError,
  )
})

test('a well-formed closed bar is accepted', () => {
  const clock = fixedClock(1_800_000_000_000)
  assert.doesNotThrow(() =>
    assertIngestable({ t: 1_699_999_200, o: 10n, h: 12n, l: 8n, c: 11n, v: 0n }, '1h', clock),
  )
})

test('staleness is counted in whole bar widths against an injected clock, not the machine clock', () => {
  const bar: Bar = { t: 1_700_000_000 - (1_700_000_000 % 3_600), o: 1n, h: 1n, l: 1n, c: 1n, v: 0n }
  assert.equal(stalenessIntervals(bar, '1h', fixedClock(bar.t * 1000)), 0)
  assert.equal(stalenessIntervals(bar, '1h', fixedClock((bar.t + 10_800) * 1000)), 3)
})

/* ------------------------------------------------------------------ helpers */

const ALICE_ID = '11111111-1111-4111-8111-111111111111'

function assertBalancedPerAsset(postings: readonly { direction: string; amount: bigint; assetCode: string }[]): void {
  const totals = new Map<string, bigint>()
  for (const posting of postings) {
    assert.ok(posting.amount > 0n, 'every posting amount must be positive')
    const delta = posting.direction === 'debit' ? posting.amount : -posting.amount
    totals.set(posting.assetCode, (totals.get(posting.assetCode) ?? 0n) + delta)
  }
  for (const [asset, total] of totals) {
    assert.equal(total, 0n, `${asset} does not balance`)
  }
}

void closes
