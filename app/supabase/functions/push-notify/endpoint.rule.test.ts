/**
 * The endpoint rule, and the fact that there is only one of it.
 *
 * Two halves. The first drives isAllowedPushEndpoint() over the cases that
 * motivated it — a metadata address, a userinfo-smuggled host, a lookalike
 * domain — because those are the ones a reader will want to see refused rather
 * than take on trust.
 *
 * The second reads migration 0023 and asserts that the SQL allowlist and the
 * TypeScript one hold the same hosts, and that the device cap the screen shows
 * is the device cap the RPC enforces. Those pairs are duplicated across a
 * language boundary and nothing else would notice them drifting apart; a
 * comment saying "keep these in step" is a wish, and this is the thing that
 * actually fails.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isAllowedPushEndpoint, PUSH_ENDPOINT_HOSTS } from './endpoint'
import { MAX_PUSH_DEVICES } from '../../../src/features/push/api'

const here = dirname(fileURLToPath(import.meta.url))
const migrationDir = join(here, '..', '..', 'migrations')

/**
 * Every migration, in apply order.
 *
 * All of them rather than the one that introduced the rule, because a later
 * migration can CREATE OR REPLACE the same function — 0024 does exactly that to
 * add a log line. Reading only 0023 would then be checking a definition the
 * database no longer runs, which is the failure this test exists to prevent.
 */
const migrations = readdirSync(migrationDir)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => ({ name, text: readFileSync(join(migrationDir, name), 'utf8') }))

describe('isAllowedPushEndpoint', () => {
  it.each([
    ['Chrome/FCM', 'https://fcm.googleapis.com/fcm/send/cSyNtHeTiC-token-value'],
    ['the older Google endpoint', 'https://android.googleapis.com/gcm/send/cSyNtHeTiC-token'],
    ['Safari', 'https://web.push.apple.com/QSyNtHeTiC-token-value-here'],
    ['Firefox', 'https://updates.push.services.mozilla.com/wpush/v2/gSyNtHeTiC-token'],
    ['Edge/WNS', 'https://wns2-par02p.notify.windows.com/w/?token=SyNtHeTiC-token'],
  ])('accepts %s', (_label, endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(true)
  })

  it.each([
    // The finding itself: an approved member storing an address inside our own
    // network and having the function fetch it with the service role.
    [
      'a cloud metadata address',
      'https://169.254.169.254/latest/meta-data/iam/security-credentials/',
    ],
    ['loopback', 'http://127.0.0.1:8798/push/ep/live'],
    ['a private range host', 'https://10.0.0.5/internal/admin'],
    ['a bare hostname', 'https://localhost/x-x-x-x-x-x-x-x-x'],
    // Everything below reads as an allowed host at a glance and is not one.
    ['userinfo smuggling the real host', 'https://fcm.googleapis.com@evil.example/fcm/send/x'],
    ['a lookalike suffix domain', 'https://fcm.googleapis.com.evil.example/fcm/send/x'],
    ['a prefix that is not a subdomain', 'https://notfcm.googleapis.com/fcm/send/x'],
    ['an allowed host on a port', 'https://fcm.googleapis.com:8798/fcm/send/x'],
    ['plain http to an allowed host', 'http://fcm.googleapis.com/fcm/send/x-x-x-x-x'],
    ['a scheme that is not http at all', 'file:///etc/passwd-x-x-x-x-x-x-x'],
    ['an allowed host with no path', 'https://fcm.googleapis.com'],
    ['whitespace hiding a second URL', 'https://fcm.googleapis.com/fcm/send/x https://evil.example/'],
  ])('refuses %s', (_label, endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(false)
  })

  it.each([[''], ['   '], ['https://'], ['not a url at all']])(
    'refuses the malformed value %j',
    (endpoint) => {
      expect(isAllowedPushEndpoint(endpoint)).toBe(false)
    },
  )

  it('refuses values that are not strings', () => {
    for (const value of [null, undefined, 42, {}, ['https://fcm.googleapis.com/fcm/send/x']]) {
      expect(isAllowedPushEndpoint(value)).toBe(false)
    }
  })

  it('refuses an endpoint longer than the column rule allows', () => {
    expect(isAllowedPushEndpoint(`https://fcm.googleapis.com/fcm/send/${'x'.repeat(1000)}`)).toBe(
      false,
    )
  })
})

describe('the rule is defined once', () => {
  it('the SQL allowlist and the TypeScript allowlist name the same hosts', () => {
    // The last migration that defines the function is the one the database is
    // actually running.
    const defining = migrations.filter((file) =>
      file.text.includes('create or replace function public.is_push_endpoint'),
    )
    expect(defining.length).toBeGreaterThan(0)
    const latest = defining[defining.length - 1]!.text

    // The VALUES list inside is_push_endpoint(), which is the only place in the
    // migration where a bare quoted hostname stands on a line of its own.
    const definition = latest.slice(
      latest.indexOf('create or replace function public.is_push_endpoint'),
      latest.indexOf('comment on function public.is_push_endpoint'),
    )
    const sqlHosts = [...definition.matchAll(/^\s*\('([a-z0-9.-]+\.[a-z]{2,})'\),?\s*$/gm)].map(
      (match) => match[1],
    )

    expect(sqlHosts.length).toBeGreaterThan(0)
    expect([...sqlHosts].sort()).toEqual([...PUSH_ENDPOINT_HOSTS].sort())
  })

  it('every copy of the device cap agrees with the one the screen shows', () => {
    // Every occurrence, not the first: 0024 re-emits the RPC, so the constant
    // now exists in two files and a later edit could change one of them alone.
    const declared = migrations.flatMap((file) =>
      [...file.text.matchAll(/v_max_devices constant int := (\d+);/g)].map((match) => ({
        file: file.name,
        value: Number(match[1]),
      })),
    )

    expect(declared.length).toBeGreaterThan(0)
    expect(declared.filter((entry) => entry.value !== MAX_PUSH_DEVICES)).toEqual([])
  })
})
