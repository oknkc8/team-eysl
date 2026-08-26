import { describe, expect, it } from 'vitest'
import { buildFixtureWorkbook } from './fixture.ts'
import { parseClubWorkbook, type ImportedRecord } from './parse.ts'
import { dedupeRecords, toSql } from './toSql.ts'

const sql = () => toSql(parseClubWorkbook(buildFixtureWorkbook()))

const record = (over: Partial<ImportedRecord> = {}): ImportedRecord => ({
  nickname: '일',
  category: 'meet',
  subcategory: 'personal',
  stroke: '자유형',
  distanceM: 50,
  eventName: '테스트 대회',
  eventDate: '2026-03-08',
  resultDisplay: '44.40',
  resultCentiseconds: 4440,
  memo: '',
  dateSource: 'label',
  distanceAssumed: false,
  ...over,
})

describe('idempotency', () => {
  it('upserts every table it writes', () => {
    const out = sql()
    // Without these four, a second run duplicates instead of updating.
    expect(out).toContain('on conflict (lower(nickname)) do update set')
    expect(out).toContain('on conflict (id) do update set')
    expect(out).toContain('on conflict (activity_id, member_id) do update set')
    expect(out).toContain(
      'on conflict (member_id, stroke, subcategory, event_date, distance_m, result_centiseconds)',
    )
  })

  it('derives activity ids from the thing they identify, not at random', () => {
    // activities has no natural key, so a second run can only find the row it
    // wrote last time if the id is a function of the training's date.
    expect(sql()).toContain("md5('eysl-import:training:2026-01-03')::uuid")
    expect(sql()).toBe(sql())
  })

  it('leaves status and role alone when a member already exists', () => {
    const out = sql()
    const clause = out.slice(
      out.indexOf('on conflict (lower(nickname)) do update set'),
      out.indexOf('updated_at      = now();'),
    )
    // An admin who promoted one of these members, or blocked them, must not be
    // silently reset by the next import.
    expect(clause).not.toContain('status')
    expect(clause).not.toContain('role')
  })
})

describe('what it refuses to write', () => {
  it('writes no absent rows', () => {
    expect(sql()).not.toContain("'absent'")
  })

  it('writes no relay rows', () => {
    // 11854 is the fixture's 계영 time in centiseconds. records.member_id is NOT
    // NULL and the 단체전 block names nobody, so it must not reach the insert.
    expect(sql()).not.toContain('11854')
  })

  it('carries the legacy attendance counters over as zero', () => {
    // 0016:155-157 adds historical_attendance_count_legacy to a live count of
    // attendance rows. Importing the grid *and* the counters doubles every
    // ranking, so the counters land as 0.
    expect(sql()).toContain("'approved', 'member', 0, 0)")
  })

  it('refuses to run without an administrator to name as marked_by', () => {
    expect(sql()).toContain('raise exception')
    expect(sql()).toContain("role = 'master_admin'")
  })

  it('never names a pwtest account as marked_by', () => {
    // e2e/cleanup.sql:34-36 deletes attendance whose marked_by is a pwtest
    // member. Naming pwtestadmin here would let every Playwright run delete the
    // whole club register, and cleanup removing rows would look like success.
    expect(sql()).toContain("and nickname not like 'pwtest%'")
  })
})

describe('escaping', () => {
  it('doubles a single quote rather than ending the literal', () => {
    const out = toSql({
      members: [],
      trainings: [],
      attendance: [],
      meets: [],
      relays: [],
      warnings: [],
      records: [record({ eventName: "L'eau 대회", memo: "it's fine" })],
    })
    expect(out).toContain("'L''eau 대회'")
    // The memo travels inside a JSON literal, so it is quoted twice over.
    expect(out).toContain("it''s fine")
    // And nothing anywhere closed the literal early.
    expect(out).not.toContain("'L'eau ")
  })
})

describe('dedupeRecords', () => {
  it('collapses two rows that share records_dedup_uq', () => {
    // Postgres refuses an INSERT whose own VALUES list hits one conflict key
    // twice, and the real workbook does exactly this: the 핀 section repeats a
    // meet the 일반 section already holds, on the same date.
    const { rows, dropped } = dedupeRecords([
      record(),
      record({ category: 'fin', eventName: '같은 날 핀대회' }),
    ])
    expect(rows).toHaveLength(1)
    expect(dropped).toHaveLength(1)
  })

  it('keeps rows that differ in any part of the key', () => {
    const { rows, dropped } = dedupeRecords([
      record(),
      record({ resultCentiseconds: 4441 }),
      record({ distanceM: 100 }),
      record({ stroke: '배영' }),
      record({ eventDate: '2026-04-12' }),
      record({ nickname: '이' }),
    ])
    expect(rows).toHaveLength(6)
    expect(dropped).toHaveLength(0)
  })
})

describe('verification', () => {
  it('reads the counts back after committing', () => {
    const out = sql()
    // An INSERT that reports success and a SELECT that returns the rows are
    // different claims, so the script makes the second claim itself.
    expect(out.indexOf('commit;')).toBeLessThan(out.indexOf('== imported row counts =='))
    expect(out).toContain('group by a.status')
    expect(out).toContain('group by category, subcategory')
  })
})
