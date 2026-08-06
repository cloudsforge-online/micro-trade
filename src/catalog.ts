/**
 * The strategy catalogue.
 *
 * **Ported from `crucible/packages/contracts/src/index.ts`** — the ten strategy ids, their
 * families, their parameter specs and `normalizeParams`. The prose is condensed; the numbers are
 * not, because the defaults are calibrated against the indicator definitions in
 * `src/indicators.ts` and changing one without the other silently changes what every preset means.
 *
 * ## Why this is code and not a table
 *
 * A strategy id is not data: each one is a branch in `compileSignals`. A row in a `strategies` table
 * describing a rule that no branch implements is a catalogue entry a user can select and nothing can
 * run — which is 17 §8's "no SKU without a delivery path", applied to a product with ten of them.
 * Keeping the catalogue next to the switch means adding a row without adding a branch does not
 * compile.
 */

/** Every rule this service can evaluate. Adding one here without a branch fails the typecheck. */
export type StrategyId =
  | 'buy_hold'
  | 'sma_cross'
  | 'ema_cross'
  | 'macd_trend'
  | 'rsi_reversion'
  | 'bollinger_breakout'
  | 'donchian_breakout'
  | 'atr_trailing'
  | 'grid'
  | 'dca'

export type StrategyFamily =
  | 'benchmark'
  | 'trend'
  | 'momentum'
  | 'mean_reversion'
  | 'volatility'
  | 'accumulation'

/** Parameters are plain numbers: they are periods and levels, never amounts. */
export type StrategyParams = Readonly<Record<string, number>>

export interface StrategyParamSpec {
  readonly key: string
  readonly label: string
  readonly help: string
  readonly min: number
  readonly max: number
  readonly step: number
  readonly default: number
  readonly unit?: string
}

export interface Strategy {
  readonly id: StrategyId
  readonly name: string
  readonly family: StrategyFamily
  readonly tagline: string
  /** Stated on every entry, deliberately. A catalogue that only lists upsides is advertising. */
  readonly weakness: string
  readonly params: readonly StrategyParamSpec[]
}

const P = (
  key: string,
  label: string,
  help: string,
  min: number,
  max: number,
  step: number,
  def: number,
  unit?: string,
): StrategyParamSpec => ({ key, label, help, min, max, step, default: def, ...(unit ? { unit } : {}) })

export const STRATEGIES: readonly Strategy[] = Object.freeze([
  {
    id: 'buy_hold',
    name: 'Buy & Hold',
    family: 'benchmark',
    tagline: 'Buy on the first bar, never sell.',
    weakness: 'Takes the full drawdown of every crash, in full, every time.',
    params: [],
  },
  {
    id: 'sma_cross',
    name: 'SMA Crossover',
    family: 'trend',
    tagline: 'Buy when the fast average crosses above the slow one.',
    weakness: 'Whipsaws badly in a sideways market, paying a fee on every false cross.',
    params: [
      P('fast', 'Fast period', 'Bars in the fast average. Lower reacts sooner and trades more.', 2, 100, 1, 20, 'bars'),
      P('slow', 'Slow period', 'Bars in the slow average. Must be longer than the fast one.', 5, 400, 1, 50, 'bars'),
    ],
  },
  {
    id: 'ema_cross',
    name: 'EMA Crossover',
    family: 'trend',
    tagline: 'A crossover that weights recent bars more heavily.',
    weakness: 'Reacts sooner than SMA, and therefore to more noise.',
    params: [
      P('fast', 'Fast period', 'Bars in the fast average.', 2, 100, 1, 12, 'bars'),
      P('slow', 'Slow period', 'Bars in the slow average.', 5, 400, 1, 26, 'bars'),
    ],
  },
  {
    id: 'macd_trend',
    name: 'MACD Trend',
    family: 'momentum',
    tagline: 'Long while MACD is above its signal line.',
    weakness: 'A lagging indicator of a lagging indicator; late in and late out.',
    params: [
      P('fast', 'Fast period', 'Fast EMA of the MACD line.', 2, 100, 1, 12, 'bars'),
      P('slow', 'Slow period', 'Slow EMA of the MACD line.', 5, 400, 1, 26, 'bars'),
      P('signal', 'Signal period', 'EMA taken over the MACD line itself.', 2, 100, 1, 9, 'bars'),
    ],
  },
  {
    id: 'rsi_reversion',
    name: 'RSI Reversion',
    family: 'mean_reversion',
    tagline: 'Buy oversold, sell overbought.',
    weakness: 'Buys every step of the way down in a real trend.',
    params: [
      P('period', 'RSI period', 'Bars in the RSI window.', 2, 100, 1, 14, 'bars'),
      P('oversold', 'Oversold level', 'Buy when RSI crosses below this.', 5, 45, 1, 30),
      P('overbought', 'Overbought level', 'Sell when RSI crosses above this.', 55, 95, 1, 70),
    ],
  },
  {
    id: 'bollinger_breakout',
    name: 'Bollinger Breakout',
    family: 'volatility',
    tagline: 'Buy a close above the upper band, exit at the middle.',
    weakness: 'A quiet market makes the bands narrow, and every wiggle a breakout.',
    params: [
      P('period', 'Band period', 'Bars in the moving average the bands sit around.', 5, 200, 1, 20, 'bars'),
      P('deviations', 'Deviations', 'Standard deviations to the upper and lower band.', 1, 4, 0.1, 2, 'σ'),
    ],
  },
  {
    id: 'donchian_breakout',
    name: 'Donchian Breakout',
    family: 'trend',
    tagline: 'Buy a new N-bar high, sell a new M-bar low.',
    weakness: 'Gives back a fixed slice of every trend before it exits.',
    params: [
      P('entry', 'Entry lookback', 'Bars in the high that triggers entry.', 5, 300, 1, 20, 'bars'),
      P('exit', 'Exit lookback', 'Bars in the low that triggers exit.', 3, 300, 1, 10, 'bars'),
    ],
  },
  {
    id: 'atr_trailing',
    name: 'ATR Trailing Stop',
    family: 'volatility',
    tagline: 'Enter above trend, exit on a volatility-scaled trailing stop.',
    weakness: 'A volatility spike stops it out of a trend that then continues without it.',
    params: [
      P('trend', 'Trend period', 'Average the close must exceed to enter.', 5, 400, 1, 50, 'bars'),
      P('atr', 'ATR period', 'Bars in the average true range.', 2, 100, 1, 14, 'bars'),
      P('multiple', 'ATR multiple', 'How many ATRs below the peak the stop sits.', 0.5, 10, 0.1, 3, '×'),
    ],
  },
  {
    id: 'grid',
    name: 'Grid',
    family: 'accumulation',
    tagline: 'Buy a rung on every step down from the running high.',
    weakness: 'Fills every rung and holds the lot through a market that never comes back.',
    params: [
      P('rungs', 'Rungs', 'Slices the allocation is divided into.', 2, 50, 1, 8),
      P('spacing', 'Spacing', 'Percent fall between one rung and the next.', 0.1, 20, 0.1, 2, '%'),
    ],
  },
  {
    id: 'dca',
    name: 'Dollar-Cost Average',
    family: 'accumulation',
    tagline: 'Buy a fixed slice every N bars until fully invested.',
    weakness: 'Ignores price entirely, which is the point and also the cost.',
    params: [
      P('every', 'Interval', 'Bars between one slice and the next.', 1, 400, 1, 7, 'bars'),
      P('slices', 'Slices', 'Purchases the allocation is divided into.', 2, 100, 1, 12),
    ],
  },
] satisfies readonly Strategy[])

const BY_ID = new Map(STRATEGIES.map((strategy) => [strategy.id, strategy]))

export function findStrategy(id: string): Strategy | undefined {
  return BY_ID.get(id as StrategyId)
}

export function isStrategyId(id: string): id is StrategyId {
  return BY_ID.has(id as StrategyId)
}

/**
 * Clamp a caller's parameters into the catalogue's ranges, and say what was changed.
 *
 * Ported from `crucible/packages/contracts/src/index.ts`, including both cross-field
 * repairs, because each one exists because a configuration silently produced nothing:
 *
 *   - A crossover whose "fast" leg is slower than its "slow" leg never crosses in the direction the
 *     rule tests for, so it produces zero trades and reads as a broken product rather than a bad
 *     parameter.
 *   - The same for an oversold level at or above the overbought one.
 *
 * The adjustments are RETURNED rather than silently applied, and they end up on the backtest's
 * `notes`. A parameter that was quietly changed is a result the user cannot reproduce.
 */
export function normaliseParams(
  id: StrategyId,
  params: StrategyParams,
): { params: StrategyParams; adjusted: string[] } {
  const strategy = findStrategy(id)
  if (!strategy) return { params: {}, adjusted: [] }
  const out: Record<string, number> = {}
  const adjusted: string[] = []
  for (const spec of strategy.params) {
    const raw = params[spec.key]
    if (raw === undefined || !Number.isFinite(raw)) {
      out[spec.key] = spec.default
      continue
    }
    const clamped = Math.min(spec.max, Math.max(spec.min, raw))
    if (clamped !== raw) adjusted.push(`${spec.label} clamped to ${clamped}`)
    out[spec.key] = clamped
  }
  const fast = out['fast']
  const slow = out['slow']
  if (fast !== undefined && slow !== undefined && fast >= slow) {
    out['slow'] = fast + 1
    adjusted.push('slow period raised above the fast period')
  }
  const oversold = out['oversold']
  const overbought = out['overbought']
  if (oversold !== undefined && overbought !== undefined && oversold >= overbought) {
    out['overbought'] = Math.min(95, oversold + 1)
    adjusted.push('overbought level raised above the oversold one')
  }
  return { params: out, adjusted }
}

/** Bar widths, in seconds. Used for range maths and for judging whether a bar is stale. */
export type Timeframe = '5m' | '15m' | '1h' | '4h' | '1d'

export const TIMEFRAMES: readonly Timeframe[] = Object.freeze(['5m', '15m', '1h', '4h', '1d'])

export const TIMEFRAME_SECONDS: Readonly<Record<Timeframe, number>> = Object.freeze({
  '5m': 300,
  '15m': 900,
  '1h': 3_600,
  '4h': 14_400,
  '1d': 86_400,
})

export function isTimeframe(value: string): value is Timeframe {
  return (TIMEFRAMES as readonly string[]).includes(value)
}
