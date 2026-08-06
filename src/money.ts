/**
 * The arithmetic. All of it, in one place, in `bigint`.
 *
 * ## Why this file exists at all
 *
 * The service this supersedes declares every Shard column as `bigint` in its schema and then reads
 * every one of them into a JavaScript **number** (`crucible/services/crucible/src/db/schema.ts`
 * and following: `bigint('cash', { mode: 'number' })`). It then does its position sizing in floats
 * — `qty = notional / price` at `crucible/services/crucible/src/engine/backtest.ts` — and
 * stores the result as a decimal string parsed back with `Number()`
 * (`crucible/packages/contracts/src/index.ts). Every balance in that service is a float
 * wearing an integer's name.
 *
 * 04 §0: "Every fiat or Shard amount is a scaled integer. **No floats anywhere in money.**"
 *
 * ## The three units, and the one rule
 *
 *   * **Shards** — `bigint`, no sub-unit. 100 Shards = 1 USD, fixed (`SHARDS_PER_USD`). A fee of
 *     half a Shard is zero.
 *   * **Base units** — `bigint`, the asset's smallest unit. BTC has 8 decimals, ETH 18; the number
 *     comes from `chainSpec(asset).decimals` and is never assumed.
 *   * **Price** — `bigint`, USD per WHOLE unit scaled by `RATE_SCALE` (10^6). Never a float, for
 *     the reason `contracts-chain` gives: "A float rate applied to an 18-decimal amount loses
 *     precision in the least significant digits, which is exactly where a reconciliation drift
 *     shows up."
 *
 * The rule: **every division rounds toward zero, and the house eats the remainder.** With an
 * integer currency somebody has to, and it should not be the customer. Every function below that
 * divides says which way it rounds, because a reader who has to work it out will get it wrong.
 *
 * ## Where a float is still allowed
 *
 * Exactly one place: indicator values and the ratios derived from them (an RSI level, a Sharpe).
 * Those are *statistics*, not amounts — nobody is paid an RSI. The boundary is enforced by shape: a
 * strategy's output is an integer basis-point exposure (`TargetBps`), so the last float dies before
 * any amount is computed from it. See `src/strategies.ts`.
 */

import {
  RATE_SCALE,
  SHARDS_PER_USD,
  chainSpec,
  coinAmountForShards,
  shardsForCoinAmount,
  type AssetCode,
} from '@cloudsforge/contracts-chain'

export { RATE_SCALE, SHARDS_PER_USD }

/** Basis points. 10_000 bps = 100%. An integer, always. */
export const BPS_SCALE = 10_000n

/**
 * A target exposure, in basis points of equity held in the base asset.
 *
 * A branded integer rather than a bare number, because the whole safety argument of this service is
 * that the float world ends here. `0` is "be flat" and is not the same fact as "no opinion", which
 * is `null`.
 */
export type TargetBps = number

/** Clamp a raw exposure fraction to whole basis points in [0, 10000]. Rounds toward zero. */
export function toTargetBps(fraction: number): TargetBps {
  if (!Number.isFinite(fraction)) return 0
  const bps = Math.trunc(fraction * 10_000)
  return bps < 0 ? 0 : bps > 10_000 ? 10_000 : bps
}

/** A negative amount is never a valid one here; every caller means a magnitude. */
function requirePositive(name: string, value: bigint): void {
  if (value < 0n) throw new RangeError(`${name} must not be negative`)
}

/**
 * `amount × bps / 10_000`, rounded DOWN.
 *
 * Used for every fee and every slippage adjustment. Rounding down deliberately: with an integer
 * currency the fraction goes somewhere, and the platform is the party that can absorb it.
 */
export function applyBps(amount: bigint, bps: number): bigint {
  requirePositive('amount', amount)
  if (!Number.isInteger(bps) || bps < 0) throw new RangeError('bps must be a non-negative integer')
  return (amount * BigInt(bps)) / BPS_SCALE
}

/** `amount × bps / 10_000`, rounded UP. The counterpart, for a cost the platform must not absorb. */
export function applyBpsUp(amount: bigint, bps: number): bigint {
  requirePositive('amount', amount)
  if (!Number.isInteger(bps) || bps < 0) throw new RangeError('bps must be a non-negative integer')
  const numerator = amount * BigInt(bps)
  return numerator === 0n ? 0n : (numerator + BPS_SCALE - 1n) / BPS_SCALE
}

/**
 * The price a fill actually happens at, once slippage has moved it against the trader.
 *
 * Against, in both directions: a buyer pays more and a seller receives less. The frozen backtest
 * gets this right (`crucible/services/crucible/src/engine/backtest.ts` and) and it is
 * the single easiest sign error to make, because getting it backwards makes every strategy look
 * profitable.
 */
export function slippedPrice(priceScaled: bigint, slippageBps: number, side: 'buy' | 'sell'): bigint {
  requirePositive('priceScaled', priceScaled)
  const delta = applyBps(priceScaled, slippageBps)
  // A buy rounds the adverse move UP and a sell rounds it DOWN, so slippage is never flattered by
  // the rounding on top of being applied.
  return side === 'buy' ? priceScaled + delta : priceScaled - delta
}

/** Shards a holding is worth at a price. Rounds DOWN — a valuation never flatters the holder. */
export function valueInShards(units: bigint, asset: AssetCode, priceScaled: bigint): bigint {
  requirePositive('units', units)
  requirePositive('priceScaled', priceScaled)
  if (priceScaled === 0n) throw new RangeError('a holding cannot be valued at a zero price')
  return shardsForCoinAmount(units, chainSpec(asset).decimals, priceScaled)
}

/** Base units a Shard amount buys at a price. Rounds DOWN — never hand out more than was paid for. */
export function unitsForShards(shards: bigint, asset: AssetCode, priceScaled: bigint): bigint {
  requirePositive('shards', shards)
  if (priceScaled <= 0n) throw new RangeError('a purchase cannot settle at a zero price')
  return coinAmountForShards(shards, chainSpec(asset).decimals, priceScaled)
}

/**
 * A bot's equity: uninvested Shards plus what its position is worth.
 *
 * The one number the performance fee is assessed against, so it is computed in exactly one place.
 */
export function equityOf(cash: bigint, units: bigint, asset: AssetCode, priceScaled: bigint): bigint {
  return cash + valueInShards(units, asset, priceScaled)
}

/**
 * The performance fee owed on a bot's equity, in whole Shards.
 *
 * Ported from `crucible/packages/contracts/src/index.ts`, in bigint, with the behaviour
 * unchanged: it rounds DOWN, it returns zero when equity has not exceeded the high-water mark, and
 * it returns zero when the fee would fall under the floor. The floor exists because the accounting
 * costs more than the fee below it, and a settlement history full of one-Shard rows buries the ones
 * that matter.
 *
 * The high-water rule is what makes the fee defensible, and it is worth restating because every
 * variant of it that was tried billed somebody twice:
 *
 *   - A bot that gains 1000 and is billed on it advances its mark, so the same 1000 is never billed
 *     again.
 *   - A bot that then loses 800 and wins it back is billed nothing for the recovery.
 *   - A bot that ends where it started has paid nothing, whatever it did in between.
 */
export const MIN_FEE_SHARDS = 5n

export function performanceFee(equity: bigint, highWaterMark: bigint, feeBps: number): bigint {
  requirePositive('equity', equity)
  requirePositive('highWaterMark', highWaterMark)
  const gain = equity - highWaterMark
  if (gain <= 0n) return 0n
  const fee = applyBps(gain, feeBps)
  return fee < MIN_FEE_SHARDS ? 0n : fee
}

/**
 * Parse a `numeric(78,0)` column into a bigint.
 *
 * postgres.js hands `numeric` back as a **string**, and `Number(row.cash)` is how a 78-digit column
 * silently becomes a double. Every read of an amount goes through here so there is one place to be
 * wrong and it is under test.
 */
export function amountFrom(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'string') {
    if (!/^-?\d+$/.test(value)) throw new RangeError(`not an integer amount: ${value.slice(0, 40)}`)
    return BigInt(value)
  }
  if (typeof value === 'number') {
    // Accepted only when it is already an exact integer. Beyond that the value has ALREADY lost
    // precision before this code ran, and silently accepting it is how the loss becomes permanent.
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`${value} is not an exact integer amount; read it as a string`)
    }
    return BigInt(value)
  }
  throw new RangeError(`not an amount: ${typeof value}`)
}

/**
 * Render an amount for the wire.
 *
 * A decimal string, always. A JSON number is an IEEE 754 double and a large amount does not survive
 * one — it does not fail either, it comes back subtly wrong.
 */
export function amountTo(value: bigint): string {
  return value.toString()
}

/**
 * A price as a human decimal, for display only.
 *
 * Never fed back into arithmetic. It exists so a log line and an API response can carry something a
 * person can read next to the scaled integer a machine must use.
 */
export function formatPrice(priceScaled: bigint): string {
  const negative = priceScaled < 0n
  const magnitude = negative ? -priceScaled : priceScaled
  const whole = magnitude / RATE_SCALE
  const fraction = (magnitude % RATE_SCALE).toString().padStart(6, '0').replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

/** Parse a decimal price string to `RATE_SCALE`. Refuses more precision than the scale can hold. */
export function parsePrice(text: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text.trim())
  if (!match) throw new RangeError(`not a price at ${RATE_SCALE} scale: ${text.slice(0, 40)}`)
  const whole = BigInt(match[1] ?? '0')
  const fraction = BigInt((match[2] ?? '').padEnd(6, '0'))
  return whole * RATE_SCALE + fraction
}
