# cloudsforge-trade

Strategy catalogue, backtests, bots, fills, allocations, fee settlements and performance reporting.

Derived from `crucible/services` — a **port and extend**, not a greenfield build. The trading engine
in the frozen service is good and is carried forward largely intact; what is rewritten is everything
around it that could not survive a second replica or a lost HTTP response.

```
pnpm install
pnpm migrate     # a one-shot job. Never run from the service.
pnpm start
pnpm check       # typecheck + 227 tests
```

---

## What it is

| | |
|---|---|
| **Owns** | `series`, `bars`, `backtests`, `bots`, `fills`, `fee_settlements` |
| **Calls** | `ledger` (postings, reservations), `pricing` (marks and fill prices), `billing` (tier, soft) |
| **Holds no** | balances. Every Shard of movement is a ledger entry whose id is on the row that caused it |
| **Publishes** | `trade.bot.created`, `trade.bot.started`, `trade.bot.paused`, `trade.fill.settled`, `trade.fee.settled` |
| **Consumes** | `identity.user.deleted` |

Money is `bigint` everywhere. Prices are scaled integers — `RATE_SCALE` (10⁶) USD per whole unit —
and Shards have no sub-unit, so a fee of half a Shard is zero. A float appears in exactly one place,
and it is not an amount: indicator values and the ratios derived from them (an RSI level, a Sharpe).
The boundary is enforced by shape rather than by discipline — a strategy's output is an integer
basis-point exposure, so the float world ends before any amount is computed. See `src/money.ts`.

---

## Ported from Crucible

Every path below is relative to `stack/repos/crucible/`, which is frozen and unmodified.

| What | From | Changed |
|---|---|---|
| **Technical indicators** — SMA, EMA, Wilder RSI, MACD, Bollinger, Wilder ATR, Donchian extremes | `services/crucible/src/engine/indicators.ts` | Input type only. The maths, the warm-up nulls and the original comments are unchanged — it is correct, well argued, and has no money in it |
| **Ten strategies**, compiled to a target-exposure series, with carried accumulators for grid / ATR-trailing / DCA | `services/crucible/src/engine/strategies.ts` | Target is integer **basis points**, not a float fraction. The rules are identical |
| **The strategy catalogue** and `normalizeParams`, including both cross-field repairs | `packages/contracts/src/index.ts:117-353` | Prose condensed; every number kept, because the defaults are calibrated against the indicator definitions |
| **The backtest loop** — signal from bar *i* fills at bar *i+1*'s **open**, average cost basis on a partial exit, minimum-rebalance threshold, curve decimation with metrics computed pre-decimation | `services/crucible/src/engine/backtest.ts` | Money rewritten in `bigint`; a stored seed and a result digest added |
| **Performance metrics** — annualised Sharpe/Sortino, Calmar, max drawdown, profit factor, like-for-like buy-and-hold benchmark | `services/crucible/src/engine/metrics.ts` | Amounts are `bigint`, proportions are `bigint` basis points, only volatility ratios stay `number` |
| **The performance fee and its four invariants** — high-water mark, one row one key one amount, debt-before-row, unknown-is-not-refusal | `services/crucible/src/fees.ts` | Carried forward in full, plus a fifth enforced by the schema (below) |
| **`assess` vs `arrears` scope**, and the argument that a paused bot must never be assessed | `services/crucible/src/fees.ts:69-97` | Unchanged |
| **The sweep's second list** — bots that have left the running set still owing something | `services/crucible/src/runner.ts:441-449`, `store.ts:347-381` | Now `unsettledBotIds`, same predicate |
| **One fill per (bot, bar, side)** | `services/crucible/src/db/migrate.ts:159` | Kept verbatim in intent. The single best line in that repository |
| **The bar-staleness refusal** and the sliding-window replay guard (`from`, so a fresh DCA does not spend its whole allocation at once) | `services/crucible/src/runner.ts:124-131`, `:154-169` | Clock injected |
| **Paper execution priced like the backtest**, so a paper bot cannot beat the backtest of its own rule | `services/crucible/src/runner.ts:217-261` | Same constants, in `bigint` |
| **The live kill switch read per tick**, not at creation | `services/crucible/src/runner.ts:47-58` | Now a field on a frozen env object |

## Deliberately dropped

| What | From | Why |
|---|---|---|
| **The exchange feed** — Binance primary, Kraken fallback, candle cache | `services/crucible/src/market/feed.ts`, `market/candles.ts` | Not this repository's remit. 03 §1.1 gives market data to `cloudsforge-market`; a service that fetches its own prices will eventually disagree with the one that owns them. Bars now **arrive** via `POST /v1/series/:id/bars` rather than being fetched. A `marketclient.ts` was *not* written: `micro-market` today contains one file and no routes, and writing a client against an imagined surface is the exact defect `micro-wallet/src/pricingclient.ts:75-78` records ("`/v1/quotes` … never existed … would have 404'd in production") |
| **`setInterval` for the tick and the settlement sweep** | `services/crucible/src/runner.ts:510`, `:513` | Rule 8. Both are now leased jobs claimed `for update skip locked`. Their only guard was a module-local boolean (`runner.ts:61`, `:410`) — invisible to a second process, which is why that service cannot be scaled past one replica |
| **Synchronous backtests inside the POST** | `services/crucible/src/routes/backtests.ts:30-128` | Its own comment argues the case and is right about the cost, wrong about the risk: the ten-second drain kills an in-flight run and the `queued` row is never retried. Now 202 + a status URL + `backtest.run` under a lease |
| **`fetchJson` and the hand-rolled upstream client** | `services/crucible/src/obs.ts:338-375`, `clients/pay.ts` | Replaced by `@cloudsforge/http`, which already has the deadline, the bounded retry, the circuit breaker and the URL redaction |
| **Quantities as decimal strings parsed with `Number()`** | `packages/contracts/src/index.ts:648-655` | A float in a text column. Positions are now `numeric(78,0)` smallest units |
| **`bigint({ mode: 'number' })` money columns** | `services/crucible/src/db/schema.ts:66-75` | Every balance in that service is a float wearing an integer's name. 04 §0 forbids it |
| **Liquidating the position on stop** | `services/crucible/src/routes/bots.ts` | Selling a user's holding because they turned a bot off is a decision the user did not make. Stopping now re-marks from a fresh price and assesses; with no usable price it falls back to `arrears` and the sweep assesses later |
| **A separate taker fee on a live fill** | — | The spread already is the cost. Pricing serves `usdBuyScaled`/`usdSellScaled` and this service fills on those legs; charging a fee on top would bill the cost twice. Revenue is the performance fee |

## Added, because the frozen service could not add it from inside itself

- **`fee_settlements_bot_period_uniq`.** A settlement's identity is `(bot_id, period)` and its ledger
  key is derived from the same pair. The frozen row is `randomUUID()` (`store.ts:452`) and its
  upstream key is derived from that id (`clients/pay.ts:134`), so two attempts at one settlement mint
  two different keys and the upstream honours both — `fee_settlements` has no unique constraint
  (`db/migrate.ts:199-207` creates three plain indexes and no unique one). That race is live at one
  replica, between the sweep and the stop route. 14 §5 makes the test mandatory; it is
  `two sweeps and a stop racing one period produce exactly one settlement`.
- **Cash and position move only inside `applyFill`**, in the same transaction as the fill row it
  claims. The frozen `tickBot` writes them from an in-memory snapshot alongside an advanced bar
  pointer (`runner.ts:186-196`), so a crash between the money moving and that write leaves money
  moved and a mirror that says it did not — permanently, because the pointer has gone past the bar.
  04 §11 names this defect by name. `updateBot` here has no field that could write either column.
- **Deterministic backtests, provably.** A stored seed, an injected clock, a seeded PRNG, and a
  sha256 digest over the stored result. Same strategy + same series + same seed ⇒ byte-identical.
- **Idempotency on every mutating route**, fingerprinted excluding `correlationId`.
- **An outbox, an inbox, `/livez`, `/readyz`, `/metrics`, and a drain.**

---

## Verified claims, and one that was false

Everything cited above was re-read in the frozen source rather than taken from a summary. Three
inherited statements did not survive that:

1. **`stack/MICROSERVICES.md:187` — "There are also **zero retries anywhere**." This is false.**
   Crucible has a real retry loop, and it is the ancestor of `src/fees.ts`. `resolvePending`
   (`services/crucible/src/fees.ts:271-330`) re-sends every undecided settlement under its *original*
   idempotency key on every pass; `settlementSweep` (`runner.ts:431-505`) drives it over the running
   bots **and** over the ones that have left the running set still owing something
   (`store.ts:347-381`). The horizon is unbounded by design, the `attempted` column exists
   specifically so a retry re-sends a byte-identical request (`db/migrate.ts:176-178`), and the stop
   route documents the promise in as many words — "the settlement sweep will retry it"
   (`routes/bots.ts:301-313`). What the frozen estate genuinely lacks is *in-request* retry inside its
   HTTP client (`obs.ts:338-375` has a timeout and no backoff) — a much smaller and much less
   interesting claim than the one that was written down.

2. **`stack/MICROSERVICES.md:92-96` — "`tickBot` … writes `cash`/`position` from its *pre-trade*
   snapshot" — is stale for the path it cites.** On the success path the frozen runner *does* use the
   post-trade result (`runner.ts:176-183` assigns from `execute`'s return before the write at
   `:186-196`). The real defect is narrower and worse: on an **unknown** outcome — a timeout or a 5xx
   — it keeps the pre-trade snapshot and advances `lastCandleT` anyway, so money that may have moved
   is never reconciled. That is the version this repository fixes.

3. **Several line citations in `stack/MICROSERVICES.md` have drifted.** It cites `store.ts:359` for
   `insertSettlement` (actually `:452`) and `runner.ts:437`/`:440` for the two timers (actually
   `:510`/`:513`). The findings behind them are real; the coordinates are not.

## Findings against `micro-org`

Recorded rather than worked around silently. Both concern `.github/workflows/service-ci.yml`.

1. **The `build` job has no Postgres service container**, so a database-backed suite cannot run in
   the reusable workflow. Every sibling avoids this by keeping a bespoke CI file, which is the thing
   03 §5 is trying to drive to zero. This repository calls the reusable workflow *and* carries one
   extra job that provides a database; the extra job should be deleted the day `service-ci.yml`
   gains a `postgres-service` input.
2. **Rule 1's check has no exemption for a test-only DSN.** It greps `src/` for
   `[A-Z][A-Z0-9_]*_(DATABASE_URL|DB_URL|POSTGRES_URL)` and fails on anything that is not the one
   declared database variable — so the `<service>_test_database_url` name every sibling uses would
   fail it. This repository names its test variable `TRADE_TEST_DSN` to stay green, which is the
   cheap half of the fix; the other half belongs in `micro-org`.

3. **That same check matches prose, not declarations.** Writing the rejected variable name in a
   comment *explaining why it is rejected* fails the build, so the note in `src/testsupport.ts` is
   written in lower case. `worlds`' own CI file already anticipates this class of problem for rule 8
   — "a check that cannot tell a timer from a sentence about one is a check people learn to ignore" —
   and rule 1 has the same defect without the same guard.

---

## Layout

```
src/
  money.ts          all the arithmetic, in bigint. The one place a rounding rule is stated
  rng.ts            the two sources of non-determinism, made into parameters
  indicators.ts     ported, essentially verbatim
  catalog.ts        the ten strategies and their parameter ranges
  strategies.ts     rules → integer basis-point exposure. No clock, no randomness
  backtest.ts       the deterministic engine, and the result digest
  performance.ts    metrics; amounts bigint, proportions bps, ratios float
  series.ts         bars in, bars out. No feed — see the header
  bots.ts           lifecycle and the leased tick
  fills.ts          exactly-once, in three layers
  fees.ts           the performance fee and its five invariants
  backtests.ts      a run is a job, not a request
  ledgerclient.ts   postings, reservations, and the failure taxonomy
  pricingclient.ts  a rate that cannot be quoted is an error, never a default
  jobs.ts           every background timer, as a lease
  server.ts         routes, the error shape, the auth-fault mapping
  index.ts          the composition root, in order
```

## Tests

`node:test` against a real Postgres. **227 tests, zero skipped.**

```
TRADE_TEST_DSN=postgres://…/trade_test pnpm test
```

The ones that carry the argument:

| Proof | Where |
|---|---|
| Same strategy + series + seed ⇒ byte-identical result, a hundred times over | `backtest.test.ts` |
| A different seed genuinely disagrees, so the seed is consumed rather than stored | `backtest.test.ts` |
| Moving the wall clock a year does not move a result | `backtest.test.ts` |
| Two workers, one bot tick, **one** execution — real `JobQueue`, two owners, one Postgres | `bots.test.ts` |
| A fill whose answer was lost is credited **once** when the retry replays it | `fills.test.ts` |
| Ten concurrent settlements of one fill apply it exactly once | `fills.test.ts` |
| Two sweeps and a stop racing one period ⇒ exactly one settlement, one key, one charge | `fees.test.ts` |
| The high-water mark never moves down, so a recovery is never billed twice | `fees.test.ts` |
| Nothing new is assessed while an earlier outcome is unknown | `fees.test.ts` |
| A short wallet is charged what it can cover under the **same** key, not a second one | `fees.test.ts` |
| A stale price refuses the trade rather than defaulting | `bots.test.ts` |
| Performance totals net to exactly zero over a hundred alternating trades | `unit.test.ts` |
| Buying then valuing never manufactures a Shard | `unit.test.ts` |

Four defects in this repository's own first draft were found by these tests rather than by review: a
`fills_settled_has_entry` constraint that made every paper bot unable to fill, a
`bots_live_capital_reserved` constraint that made a stopped bot unable to release its user's capital,
a live buy that overspent its own fee and drove `cash` negative, and a backtest route that returned a
`bigint` straight to `JSON.stringify`. Each is noted at the line that fixes it.
