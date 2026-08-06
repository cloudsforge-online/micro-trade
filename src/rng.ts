/**
 * The two sources of non-determinism, made into parameters.
 *
 * **A backtest is deterministic or it is worthless.** A user compares two runs and concludes one
 * rule is better than another; if the same input can produce two answers, that conclusion is noise
 * and the product is a random number generator with a chart.
 *
 * There are exactly two ways non-determinism gets into a strategy evaluation, and both are banned
 * by construction rather than by discipline:
 *
 *   1. `Math.random()`. Replaced by `seededRandom(seed)`, whose output is a pure function of the
 *      seed and the call count. The seed is stored on the `backtests` row, so a run is reproducible
 *      from what is in the database rather than from what was in memory.
 *   2. A wall-clock read. Replaced by an injected `Clock`. Nothing in `src/backtest.ts`,
 *      `src/strategies.ts` or `src/indicators.ts` may import `Date` — the bar's own `t` is the only
 *      time an evaluation has, which is also what stops a strategy from knowing anything the bar
 *      did not.
 *
 * The frozen service does not have this problem in its backtest, which is genuinely deterministic
 * — but it has it in its LIVE path, where `tickBot` reads `Date.now()` mid-evaluation to age the
 * candle (`crucible/services/crucible/src/runner.ts`). That read is correct behaviour and the
 * wrong place for it: it makes the tick untestable without moving the machine clock, which is why
 * the staleness check here takes a `Clock` and lives in `src/bots.ts` rather than in the engine.
 */

/** Time, as a parameter. Milliseconds since the epoch, the same unit `Date.now()` returns. */
export interface Clock {
  now(): number
}

/** The real one. Constructed at the composition root and nowhere else. */
export const systemClock: Clock = { now: () => Date.now() }

/** A clock that does not move, for tests that assert on an instant. */
export function fixedClock(atMs: number): Clock {
  return { now: () => atMs }
}

/**
 * A seeded uniform generator on [0, 1).
 *
 * `mulberry32`: 32 bits of state, one multiply-shift round per call. Chosen over the obvious
 * alternatives for reasons that matter here and nowhere else:
 *
 *   - It is **exactly reproducible across engines and versions**, because every operation is a
 *     32-bit integer operation written out in full. `Math.random()` is explicitly permitted to
 *     differ between runs of the same binary; a Mersenne Twister would also be reproducible but is
 *     six hundred lines to say the same thing.
 *   - The final `/ 4294967296` is the only floating-point operation, and it is exact: the numerator
 *     is a 32-bit integer and the divisor is a power of two, so the quotient is representable
 *     without rounding. Two runs therefore produce byte-identical doubles, not merely close ones.
 *
 * Quality is not the point and is not claimed. This drives execution jitter in a simulation, not a
 * key.
 */
export function seededRandom(seed: number): () => number {
  // Coerced into the 32-bit domain up front so a caller passing a bigint-ish or negative seed gets
  // a defined, reproducible stream rather than NaN forever after.
  let state = Math.trunc(seed) >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/**
 * Turn a uniform draw into a symmetric integer jitter in [-spanBps, +spanBps].
 *
 * This is what makes the seed MEAN something. Without it the seed would be recorded, stored and
 * ignored, and "same seed, same result" would be true for the uninteresting reason that nothing
 * consumed it — which is not a determinism guarantee, it is an absence of randomness. With it, two
 * seeds genuinely disagree and the test that asserts they do is testing something.
 *
 * Returns whole basis points, because the value is about to be handed to `applyBps` and the float
 * world must not survive past this function.
 */
export function jitterBps(random: () => number, spanBps: number): number {
  if (spanBps <= 0) return 0
  const span = Math.trunc(spanBps)
  // `Math.round` rather than `trunc`: truncation toward zero biases the draw upward for negatives
  // and downward for positives, which over a long run is a systematic drift rather than jitter.
  return Math.round((random() * 2 - 1) * span)
}
