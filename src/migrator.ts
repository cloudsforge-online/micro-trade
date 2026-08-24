/**
 * The one-shot migrator.
 *
 * A separate process, run as an init container or a Kubernetes Job, and **never** called from
 * `index.ts`. Three reasons, in increasing order of seriousness:
 *
 *   1. A slow migration would stall every service that waits on this one's health.
 *   2. Two replicas booting together race on `pg_type`, one raises 23505 and crash-loops — which is
 *      why the estate cannot scale a service past one replica today.
 *   3. Migrating from inside the service means the service decides when the schema changes, so a
 *      rollback of the image is not a rollback of the database.
 *
 * Safe to run concurrently from N processes: `@cloudsforge/db` serialises them on an advisory lock
 * derived from the service name, and the losers observe an empty pending set.
 */

import postgres from 'postgres'
import { migrate, type Sql } from '@cloudsforge/db'
import { Logger } from '@cloudsforge/telemetry'
import { SERVICE, env } from './env.ts'
import { BASELINE_VERSION, MIGRATIONS } from './migrations.ts'

const log = new Logger({
  service: SERVICE,
  level: env.logLevel,
  version: env.version,
  env: env.env,
}).child({ step: 'migrate' })

// ── EVERY DATABASE THIS DEPLOYMENT HOLDS ──────────────────────────────────────────────────────
//
// One entry until the service's testnet database is adopted into this cluster
// (`docs/network-consolidation.md` §6), two afterwards. Migrating only the first is the failure
// that would not show up here: the migrator exits 0, the deploy goes green, and the NEXT release's
// boot-time schema assertion finds the second database behind and refuses to serve testnet.
const targets: ReadonlyArray<readonly [string, string]> = [
  ['primary', env.databaseUrl],
  ...(env.databaseUrlTestnet ? ([['testnet', env.databaseUrlTestnet]] as const) : []),
]
let failed = false
for (const [network, url] of targets) {
  // A tiny pool: the whole run happens on one reserved connection, and a wide pool here only makes
  // a migration that has to wait for a lock hold more of the database's connection budget.
  const sql = postgres(url, { max: 2, onnotice: () => {} })
  try {
    const result = await migrate(sql as unknown as Sql, MIGRATIONS, {
      service: SERVICE,
      // See the note on BASELINE_VERSION. Zero for a new service, which makes this a no-op.
      baselineVersion: BASELINE_VERSION,
      onLog: (message, fields) => log.info(message, { ...fields, network }),
    })
    log.info('migrations complete', {
      network,
      from: result.alreadyAt,
      to: result.nowAt,
      applied: result.applied.map((a) => `${a.version}:${a.name}`),
    })
  } catch (err) {
    // Recorded and carried on, so one run reports EVERY database that is wrong rather than the
    // first. An operator who fixes one and rediscovers the next on the following deploy has been
    // given the same information twice at twice the cost.
    log.fatal('migration failed', { err, network })
    failed = true
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {})
  }
}

// Exit non-zero and loudly. The deploy must stop here: a service started against a schema its
// migrator could not reach is the failure this whole arrangement exists to prevent.
process.exit(failed ? 1 : 0)
