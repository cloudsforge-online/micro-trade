/**
 * Candle series: the input a backtest runs over and a bot ticks on.
 *
 * ## Why there is no exchange feed in this repository
 *
 * The frozen service fetches its own candles, from Binance with a Kraken fallback
 * (`crucible/services/crucible/src/market/feed.ts`), and caches them in its own table
 * (`crucible/services/crucible/src/market/candles.ts`). That code is good — the fallback exists
 * because "the way Binance fails in a restricted region is an HTTP 451 on every request forever"
 * (`feed.ts`), which is a real thing somebody learned the hard way.
 *
 * It is still not this service's job. 03 §1.1 gives `cloudsforge-market` the market-data surface and
 * gives this repository "strategy catalogue, backtests, bots, fills, allocations, fee settlements,
 * performance reporting" — no feed. A service that fetches its own prices is a service that will
 * disagree with the one that is supposed to own them, and two products quoting different prices for
 * one asset is the failure `cloudsforge-pricing` exists to prevent.
 *
 * So: **bars arrive; they are not fetched.** They are written by an authenticated ingest route
 * (`POST /v1/series/:id/bars`, scope `trade:write`), which today is driven by an operator or a
 * backfill script and tomorrow by `market`.
 *
 * That is a deliberate, stated trade-off rather than an oversight, and the alternative was worse.
 * `micro-wallet`'s pricing client carries the scar: it was written against `GET /v1/quotes`, a route
 * that "never existed — this client was written against an imagined surface and would have 404'd in
 * production" (`micro-wallet/src/pricingclient.ts`). Writing a `marketclient.ts` against
 * `micro-market`, which today contains one file and no routes at all, would have reproduced exactly
 * that defect. A route that does not exist is not a dependency; it is a guess.
 *
 * ## Bars are immutable and closed
 *
 * A closed bar never changes, so ingest is `on conflict do nothing` rather than an upsert: a feed
 * that revises a bar is a feed disagreeing with a backtest that already ran against it, and silently
 * accepting the revision makes that run unreproducible. The in-progress bar is refused outright —
 * feeding it to an indicator lets a strategy see a close that has not happened yet, which turns a
 * losing rule into a winning one.
 */

import { amountFrom } from './money.ts'
import { TIMEFRAME_SECONDS, type Timeframe } from './catalog.ts'
import type { Bar } from './indicators.ts'
import type { Clock } from './rng.ts'
import type { Db, Tx } from './outbox.ts'

export interface SeriesRecord {
  readonly id: string
  readonly symbol: string
  readonly assetCode: string
  readonly timeframe: Timeframe
  readonly source: string
}

/** A bar has to be self-consistent before it is worth storing. Mirrors `bars_range_sane`. */
export class BarRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BarRejectedError'
  }
}

interface SeriesRow {
  readonly id: string
  readonly symbol: string
  readonly asset_code: string
  readonly timeframe: string
  readonly source: string
}

interface BarRow {
  readonly t: string | number
  readonly o: string
  readonly h: string
  readonly l: string
  readonly c: string
  readonly v: string
}

const toSeries = (row: SeriesRow): SeriesRecord => ({
  id: row.id,
  symbol: row.symbol,
  assetCode: row.asset_code,
  timeframe: row.timeframe as Timeframe,
  source: row.source,
})

const toBar = (row: BarRow): Bar => ({
  t: Number(row.t),
  o: amountFrom(row.o),
  h: amountFrom(row.h),
  l: amountFrom(row.l),
  c: amountFrom(row.c),
  v: amountFrom(row.v),
})

export async function registerSeries(
  sql: Db,
  input: { symbol: string; assetCode: string; timeframe: Timeframe; source: string },
): Promise<SeriesRecord> {
  // Idempotent on (symbol, timeframe): registering the same series twice is a no-op that returns the
  // row, not a 409. Two replicas warming up must not need a leader to decide which one registers.
  const rows = await sql<SeriesRow[]>`
    insert into series (symbol, asset_code, timeframe, source)
    values (${input.symbol}, ${input.assetCode}, ${input.timeframe}, ${input.source})
    on conflict (symbol, timeframe) do update set source = excluded.source
    returning id, symbol, asset_code, timeframe, source
  `
  const row = rows[0]
  if (!row) throw new Error('series upsert returned no row')
  return toSeries(row)
}

export async function getSeries(sql: Db, id: string): Promise<SeriesRecord | null> {
  const rows = await sql<SeriesRow[]>`
    select id, symbol, asset_code, timeframe, source from series where id = ${id}
  `
  const row = rows[0]
  return row ? toSeries(row) : null
}

export async function listSeries(sql: Db): Promise<readonly SeriesRecord[]> {
  const rows = await sql<SeriesRow[]>`
    select id, symbol, asset_code, timeframe, source from series order by symbol, timeframe
  `
  return rows.map(toSeries)
}

/**
 * Reject a bar that cannot be one, or that has not closed yet.
 *
 * Separate from the database constraint on purpose. The constraint is the guarantee; this is the
 * error message. A caller that gets `23514 violates check constraint bars_range_sane` cannot tell
 * which of five bars in its batch was wrong, and 04's whole argument for named constraints is that
 * a constraint should be discoverable — not that it should be the user interface.
 */
export function assertIngestable(bar: Bar, timeframe: Timeframe, clock: Clock): void {
  if (bar.o <= 0n || bar.h <= 0n || bar.l <= 0n || bar.c <= 0n) {
    throw new BarRejectedError(`bar ${bar.t} has a non-positive price`)
  }
  if (bar.h < bar.l || bar.o < bar.l || bar.o > bar.h || bar.c < bar.l || bar.c > bar.h) {
    throw new BarRejectedError(`bar ${bar.t} is not internally consistent: o and c must lie in [l, h]`)
  }
  const width = TIMEFRAME_SECONDS[timeframe]
  if (bar.t % width !== 0) {
    throw new BarRejectedError(`bar ${bar.t} is not aligned to a ${timeframe} boundary`)
  }
  // A bar has closed once its whole width has elapsed. The comparison is against an injected clock,
  // never `Date.now()` directly, so a test can prove the refusal without moving the machine clock.
  const closesAt = (bar.t + width) * 1000
  if (closesAt > clock.now()) {
    throw new BarRejectedError(
      `bar ${bar.t} has not closed yet — an open bar lets a strategy see a price that has not happened`,
    )
  }
}

/**
 * Append bars. Returns how many were new.
 *
 * `do nothing` rather than `do update`: see the file header. A caller re-sending an overlapping
 * batch after a timeout is the normal case and must be free.
 */
export async function ingestBars(
  sql: Db | Tx,
  seriesId: string,
  bars: readonly Bar[],
): Promise<number> {
  if (bars.length === 0) return 0
  const rows = await sql<{ t: string }[]>`
    insert into bars ${sql(
      bars.map((bar) => ({
        series_id: seriesId,
        t: bar.t,
        o: bar.o.toString(),
        h: bar.h.toString(),
        l: bar.l.toString(),
        c: bar.c.toString(),
        v: bar.v.toString(),
      })),
    )}
    on conflict (series_id, t) do nothing
    returning t
  `
  return rows.length
}

/**
 * The newest `limit` bars of a series, oldest first.
 *
 * Newest-first with a LIMIT and then reversed, rather than ascending with an offset: ordering
 * ascending and taking the tail makes Postgres sort the entire history of the series on every call,
 * which the frozen service also learned (`crucible/services/crucible/src/market/candles.ts`).
 */
export async function loadBars(sql: Db, seriesId: string, limit: number): Promise<readonly Bar[]> {
  const rows = await sql<BarRow[]>`
    select t, o, h, l, c, v
      from bars
     where series_id = ${seriesId}
     order by t desc
     limit ${limit}
  `
  return rows.reverse().map(toBar)
}

/** Every bar of a series, oldest first. What a backtest reads. */
export async function loadAllBars(sql: Db, seriesId: string): Promise<readonly Bar[]> {
  const rows = await sql<BarRow[]>`
    select t, o, h, l, c, v from bars where series_id = ${seriesId} order by t asc
  `
  return rows.map(toBar)
}

/**
 * How many whole bar-widths old the newest bar is.
 *
 * A bot refuses to act on a series that has stopped updating. Trading on a price that stopped an
 * hour ago is worse than not trading: the signal is computed from a market that has moved on, and in
 * live mode it settles against an oracle that has not. The frozen runner makes the same check at
 * `crucible/services/crucible/src/runner.ts`; the difference is that this one takes its
 * clock as an argument.
 */
export function stalenessIntervals(newest: Bar, timeframe: Timeframe, clock: Clock): number {
  const width = TIMEFRAME_SECONDS[timeframe]
  return Math.floor((clock.now() / 1000 - newest.t) / width)
}
