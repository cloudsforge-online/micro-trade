/**
 * Which estate this pod is, and why nothing here may name one directly.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS CAUGHT, THREE TIMES
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A composition root that keys a per-network map by the literal:
 *
 *     networkSql({ mainnet: sql, … })                       // the database handle
 *     [{ network: 'mainnet' as const, queue: queueFor(sql) }] // the job plane
 *     for (const [network, handle] of [['mainnet', sql]])     // the schema assertion
 *
 * One image, one codebase, two deployments. The testnet pod runs those same lines and registers its
 * own testnet resources under the name `mainnet`. Then a request arrives stamped `CF-Network:
 * testnet`, the lookup finds nothing, and it refuses — correctly, and for data it is holding.
 *
 * Five services crash-looped on the first shape. Three more on the second, after the first was
 * fixed. The third was labelling a testnet pod's schema checks `mainnet` in its own logs.
 *
 * Every unit test passed throughout all three, because they assert that an unheld network is
 * REFUSED — which it was, perfectly. Nothing asserted which networks a testnet pod HOLDS.
 *
 * Read against the source rather than the runtime: booting `index.ts` opens a database and a job
 * runner, and the defect is visible in the text.
 */
import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const INDEX = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

describe('no per-network map is keyed by the literal `mainnet`', () => {
  it('does not key a tuple map with it', () => {
    assert.doesNotMatch(INDEX, /^\s*\['mainnet', /m)
  })

  it('does not key an object map with it', () => {
    assert.doesNotMatch(INDEX, /^\s*\{ network: 'mainnet' as const, /m)
  })

  it('does not key the database handle with it', () => {
    assert.doesNotMatch(INDEX, /^\s*mainnet: /m)
  })

  it('declares the estate once, from CF_NETWORK_SINGLE, above every use', () => {
    const decl = INDEX.indexOf('const ownNetwork = ')
    assert.notEqual(decl, -1, 'the pod must say which estate it is')
    assert.match(INDEX.slice(decl, decl + 120), /env\.singleNetwork/)

    const uses = [...INDEX.matchAll(/\bownNetwork\b/g)].map((m) => m.index ?? 0)
    assert.ok(uses.length > 1, 'a declaration nothing uses is the defect wearing a fix')
    assert.equal(Math.min(...uses), decl + 'const '.length, 'every use must follow the declaration')
  })
})

describe('a single-network pod cannot end up holding two testnet entries', () => {
  /*
   * The second entry is conditional on `*_DATABASE_URL_TESTNET`. Once the primary key is computed
   * rather than literal, a TESTNET pod that also has that variable set — pointing, quite possibly,
   * at the same database — builds two entries both named `testnet`, and the lookup silently returns
   * the first. So the condition carries the guard, and this asserts it stayed carried.
   */
  it('guards every second-estate entry on the pod not already being testnet', () => {
    const spreads = [...INDEX.matchAll(/\.\.\.\(sqlTestnet[\s\S]{0,60}?\?/g)]
    assert.ok(spreads.length > 0, 'the second-estate entries are what this guards')
    for (const s of spreads) {
      assert.match(s[0], /ownNetwork !== 'testnet'/, `unguarded second estate: ${s[0]}`)
    }
  })
})
