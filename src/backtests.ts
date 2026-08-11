/**
 * Backtests, as rows and as work.
 *
 * **The one behavioural change from the frozen service.** It runs a backtest inside the POST
 * (`crucible/services/crucible/src/routes/backtests.ts`) and argues the case in its own
 * comment: "A thousand candles through ten indicators is single-digit milliseconds; the
 * only slow part is the feed … A job queue here would buy nothing but a polling endpoint and a way
 * for a result to go missing."
 *
 * That argument is right about the cost and wrong about the risk. The failure it does not account
 * for is the **drain**: a SIGTERM arrives, the process has ten seconds, and an in-flight run dies
 * with the request — and because the row was written `queued` before the work started, the user is
 * left with a run that never completes and nothing to retry it. Deploys are frequent and backtests
 * are the thing users do most.
 *
 * So the route answers **202 with a status url** and `backtest.run` does the work under a lease. The
 * cost is the polling endpoint the frozen comment predicted; the benefit is that a run survives a
 * deploy, is retried on failure with a bounded attempt budget, and cannot be lost.
 *
 * The lease key is `backtest:<id>` — the contended resource is that run, and two workers completing
 * one run would race on `result_digest`.
 */

import { Logger } from '@cloudsforge/telemetry'
import type { AssetCode } from '@cloudsforge/contracts-chain'
import { amountFrom } from './money.ts'
import { run, serialiseResult } from './backtest.ts'
import { loadAllBars, getSeries } from './series.ts'
import { isStrategyId, type StrategyId, type StrategyParams } from './catalog.ts'
import type { Db, Tx } from './outbox.ts'

/** Fewest bars a run may draw a conclusion from. Below this the statistics are noise. */
export const MIN_BARS = 60

/** Most bars one run may read, so a single request cannot pull an unbounded series into memory. */
export const MAX_BARS = 20_000

export type BacktestStatus = 'queued' | 'running' | 'complete' | 'failed'

export interface BacktestRecord {
  readonly id: string
  readonly userId: string
  readonly status: BacktestStatus
  readonly seriesId: string
  readonly strategyId: StrategyId
  readonly params: StrategyParams
  readonly seed: number
  readonly startCash: bigint
  readonly feeBps: number
  readonly slippageBps: number
  readonly fromT: number | null
  readonly toT: number | null
  readonly resultDigest: string | null
  readonly metrics: unknown
  readonly notes: readonly string[]
  readonly error: string | null
}

interface BacktestRow {
  readonly id: string
  readonly user_id: string
  readonly status: string
  readonly series_id: string
  readonly strategy_id: string
  readonly params: StrategyParams
  readonly seed: string | number
  readonly start_cash: string
  readonly fee_bps: number
  readonly slippage_bps: number
  readonly from_t: string | number | null
  readonly to_t: string | number | null
  readonly result_digest: string | null
  readonly metrics: unknown
  readonly notes: readonly string[]
  readonly error: string | null
}

const COLUMNS = `id, user_id, status, series_id, strategy_id, params, seed, start_cash, fee_bps,
  slippage_bps, from_t, to_t, result_digest, metrics, notes, error`

/**
 * micro-org#418: the money keys a STORED result was written with, and what they are called now.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS IS NOT A COMPATIBILITY SHIM FOR CLIENTS. IT IS A READER FOR OLD ROWS, AND IT IS REQUIRED.
 *
 * `metrics`, `trades` and `equity` are `jsonb`. `serialiseResult` writes them from the TypeScript
 * field names, so every backtest completed before this change has `feesPaidShards` inside its JSON
 * and every one completed after has `feesPaidUsdCents`. The column is opaque to the type system —
 * `metrics: unknown` below, `readonly unknown[]` on the result rows — so renaming the interfaces in
 * `src/performance.ts` did not and could not make the stored documents follow.
 *
 * Without this, the compiler stays green, every test that runs a fresh backtest stays green, and
 * EVERY BACKTEST A CUSTOMER ALREADY HAS renders a blank where its fees, its best trade and its
 * worst trade used to be — because `undefined` is not `'0'`, so a client's "absent" branch does not
 * fire either. That is exactly how micro-worlds' `rewardShards`→`rewardWei` rename put 47 blank
 * amounts on mainnet for a year: nothing was red, because nothing tested the old shape.
 *
 * A jsonb data migration would fix it once and for all, and is the right thing eventually. It is
 * not done here: it would have to rewrite an array of fills per row, in a migration, on the same
 * deploy that renames everything else, and this mapping is exact, cheap and reversible. When that
 * migration lands, delete this map and this test will tell you it is safe to.
 *
 * The values are UNTOUCHED. One Shard was exactly one cent (`src/money.ts`), so a stored figure is
 * already correct under its new name; only the key moves.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const RENAMED_MONEY_KEYS: Readonly<Record<string, string>> = {
  feesPaidShards: 'feesPaidUsdCents',
  bestTradeShards: 'bestTradeUsdCents',
  worstTradeShards: 'worstTradeUsdCents',
  notionalShards: 'notionalUsdCents',
  feeShards: 'feeUsdCents',
  pnlShards: 'pnlUsdCents',
}

/**
 * Rename the money keys of one stored JSON object, one level deep, leaving every value alone.
 *
 * A non-object — including `null`, which `metrics` is until a run completes — comes back as it went
 * in. An object that already carries the new name is left alone rather than overwritten, so a row
 * written after this change is never rewritten by a stale key that happens to sit beside it.
 */
export function renameStoredMoneyKeys(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const source = value as Record<string, unknown>
  let touched = false
  const out: Record<string, unknown> = {}
  for (const [key, held] of Object.entries(source)) {
    const renamed = RENAMED_MONEY_KEYS[key]
    if (renamed !== undefined && !(renamed in source)) {
      out[renamed] = held
      touched = true
    } else {
      out[key] = held
    }
  }
  return touched ? out : value
}

function toBacktest(row: BacktestRow): BacktestRecord {
  if (!isStrategyId(row.strategy_id)) {
    throw new Error(`backtest ${row.id} names an unknown strategy ${row.strategy_id}`)
  }
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status as BacktestStatus,
    seriesId: row.series_id,
    strategyId: row.strategy_id,
    params: row.params,
    seed: Number(row.seed),
    startCash: amountFrom(row.start_cash),
    feeBps: row.fee_bps,
    slippageBps: row.slippage_bps,
    fromT: row.from_t === null ? null : Number(row.from_t),
    toT: row.to_t === null ? null : Number(row.to_t),
    resultDigest: row.result_digest,
    metrics: renameStoredMoneyKeys(row.metrics),
    notes: row.notes ?? [],
    error: row.error,
  }
}

export interface QueueBacktestInput {
  readonly userId: string
  readonly seriesId: string
  readonly strategyId: StrategyId
  readonly params: StrategyParams
  readonly seed: number
  readonly startCash: bigint
  readonly feeBps: number
  readonly slippageBps: number
  readonly notes: readonly string[]
}

export async function queueBacktest(sql: Db | Tx, input: QueueBacktestInput): Promise<BacktestRecord> {
  const rows = await sql<BacktestRow[]>`
    insert into backtests (user_id, series_id, strategy_id, params, seed, start_cash, fee_bps, slippage_bps, notes)
    values (
      ${input.userId}, ${input.seriesId}, ${input.strategyId},
      ${sql.json(input.params as Record<string, never>)}, ${input.seed},
      ${input.startCash.toString()}, ${input.feeBps}, ${input.slippageBps},
      ${sql.json(input.notes as unknown as Record<string, never>)}
    )
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new Error('backtest insert returned no row')
  return toBacktest(row)
}

export async function getBacktest(sql: Db, id: string): Promise<BacktestRecord | null> {
  const rows = await sql<BacktestRow[]>`select ${sql.unsafe(COLUMNS)} from backtests where id = ${id}`
  const row = rows[0]
  return row ? toBacktest(row) : null
}

export async function getOwnedBacktest(sql: Db, id: string, userId: string): Promise<BacktestRecord | null> {
  const rows = await sql<BacktestRow[]>`
    select ${sql.unsafe(COLUMNS)} from backtests where id = ${id} and user_id = ${userId}
  `
  const row = rows[0]
  return row ? toBacktest(row) : null
}

/**
 * The two result columns no read path selected, and why they are read separately.
 *
 * `runBacktest` writes `trades` and `equity` alongside `metrics` (see the update in this file),
 * and `migrations.ts` declares both as `jsonb`. But `COLUMNS` above lists neither, so **nothing
 * could read them**: a completed backtest computed its equity curve and its fill list, stored
 * both, and then served only the summary. A client could show how deep a drawdown was and never
 * when it happened, which is the question the curve exists to answer.
 *
 * They stay out of `COLUMNS` deliberately rather than being added to it. `listBacktests` returns
 * up to `limit` rows, and an equity curve is decimated to `MAX_CURVE_POINTS` — putting both into
 * every list response would make the index page pay for a chart nobody has opened yet. So this is
 * a separate read, mirroring `GET /v1/bots/:id/fills`, which is the same shape for the same
 * reason.
 *
 * `null` when the row is absent or not this user's; the arrays are null until the run completes,
 * which the route reports as a state rather than as an empty result — an empty fill list is a
 * real answer a strategy can produce, and it must not be confused with "not finished".
 */
export interface BacktestResultRows {
  readonly status: BacktestStatus
  readonly fills: readonly unknown[] | null
  readonly equity: readonly unknown[] | null
}

export async function getOwnedBacktestResult(
  sql: Db,
  id: string,
  userId: string,
): Promise<BacktestResultRows | null> {
  const rows = await sql<{ status: string; trades: unknown; equity: unknown }[]>`
    select status, trades, equity from backtests where id = ${id} and user_id = ${userId}
  `
  const row = rows[0]
  if (!row) return null
  return {
    status: row.status as BacktestStatus,
    fills: Array.isArray(row.trades) ? row.trades.map(renameStoredMoneyKeys) : null,
    equity: Array.isArray(row.equity) ? (row.equity as readonly unknown[]) : null,
  }
}

export async function listBacktests(sql: Db, userId: string, limit: number): Promise<readonly BacktestRecord[]> {
  const rows = await sql<BacktestRow[]>`
    select ${sql.unsafe(COLUMNS)} from backtests where user_id = ${userId} order by created_at desc limit ${limit}
  `
  return rows.map(toBacktest)
}

export interface RunBacktestDeps {
  readonly sql: Db
  readonly logger: Logger
}

export type RunBacktestResult = 'complete' | 'failed' | 'gone' | 'already'

/**
 * Execute a queued run.
 *
 * Idempotent by the same trick the fills use: the claim is a conditional `UPDATE … WHERE status =
 * 'queued'`. A second worker that finds the row already `running` or `complete` returns `already`
 * and does nothing, so the digest is written once even if the lease were somehow held twice.
 */
export async function runBacktest(deps: RunBacktestDeps, id: string): Promise<RunBacktestResult> {
  const claimed = await deps.sql<BacktestRow[]>`
    update backtests set status = 'running' where id = ${id} and status = 'queued'
    returning ${deps.sql.unsafe(COLUMNS)}
  `
  const row = claimed[0]
  if (!row) {
    const exists = await getBacktest(deps.sql, id)
    return exists ? 'already' : 'gone'
  }
  const backtest = toBacktest(row)

  try {
    const series = await getSeries(deps.sql, backtest.seriesId)
    if (!series) throw new Error('the series this run names no longer exists')

    const bars = await loadAllBars(deps.sql, backtest.seriesId)
    if (bars.length < MIN_BARS) {
      await fail(
        deps.sql,
        id,
        `only ${bars.length} bars available for ${series.symbol} ${series.timeframe} — not enough to draw a conclusion from`,
      )
      return 'failed'
    }
    const window = bars.length > MAX_BARS ? bars.slice(bars.length - MAX_BARS) : bars

    const result = run({
      bars: window,
      strategyId: backtest.strategyId,
      params: backtest.params,
      timeframe: series.timeframe,
      asset: series.assetCode as AssetCode,
      startCash: backtest.startCash,
      feeBps: backtest.feeBps,
      slippageBps: backtest.slippageBps,
      seed: backtest.seed,
    })

    const notes = [...backtest.notes]
    if (result.metrics.trades === 0) {
      notes.push('this configuration produced no trades at all — the parameters are probably too slow for the window')
    }
    if (bars.length > MAX_BARS) {
      notes.push(`the series has ${bars.length} bars; the newest ${MAX_BARS} were used`)
    }

    const stored = serialiseResult(result)
    await deps.sql`
      update backtests
         set status        = 'complete',
             from_t        = ${result.from},
             to_t          = ${result.to},
             result_digest = ${result.digest},
             metrics       = ${deps.sql.json(stored['metrics'] as Record<string, never>)},
             trades        = ${deps.sql.json(stored['fills'] as unknown as Record<string, never>)},
             equity        = ${deps.sql.json(stored['equity'] as unknown as Record<string, never>)},
             notes         = ${deps.sql.json(notes as unknown as Record<string, never>)},
             error         = null,
             completed_at  = now()
       where id = ${id}
    `
    return 'complete'
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    deps.logger.error('backtest failed', { backtestId: id, err: message })
    await fail(deps.sql, id, message)
    return 'failed'
  }
}

async function fail(sql: Db, id: string, message: string): Promise<void> {
  await sql`
    update backtests
       set status = 'failed', error = ${message.slice(0, 2_000)}, completed_at = now()
     where id = ${id}
  `
}
