import { describe, expect, it } from 'vitest'
import { buildFixtureWorkbook } from './fixture.ts'
import { parseClubWorkbook, type ImportedRecord } from './parse.ts'
import { DuplicateRecordError, dedupeRecords, toSql } from './toSql.ts'

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
  it('handles a conflict on every table it writes, and never by updating', () => {
    const out = sql()
    // DO NOTHING, not DO UPDATE. DO UPDATE kept the row counts identical while
    // rewriting real_name, activity title/date and attendance status on every
    // run — reverting edits people had made in the app. See the header comment
    // in toSql.ts, and scripts/import/verify-idempotence.sh, which is the thing
    // that can actually catch a regression here.
    expect(out).toContain('on conflict (lower(nickname)) do nothing;')
    expect(out).toContain('on conflict (id) do nothing;')
    expect(out).toContain('on conflict (activity_id, member_id) do nothing;')
    expect(out).toContain(
      'on conflict (member_id, category, stroke, subcategory, event_date, distance_m, ' +
        'result_centiseconds)',
    )
    expect(out).not.toContain('do update set')
    // updated_at = now() on a row whose values did not change is a write that
    // says something changed. Nothing here should emit one.
    expect(out).not.toContain('updated_at = now()')
  })

  it('names the post-0031 conflict target for records', () => {
    // records_dedup_uq gained `category` in 0031. ON CONFLICT resolves against a
    // unique index by column set, so naming the old list against the new index
    // raises 42P10 on the first row — driven and confirmed, not assumed.
    const out = sql()
    expect(out).toContain('on conflict (member_id, category, stroke')
    expect(out).not.toContain('on conflict (member_id, stroke, subcategory')
  })

  it('derives activity ids from the thing they identify, not at random', () => {
    // activities has no natural key, so a second run can only find the row it
    // wrote last time if the id is a function of the training's date.
    expect(sql()).toContain("md5('eysl-import:training:2026-01-03')::uuid")
    expect(sql()).toBe(sql())
  })

  it('leaves an existing member entirely alone', () => {
    // Stronger than the previous version, which only checked that status and
    // role were absent from a DO UPDATE list. Nothing is updated now, so an
    // admin promotion, a block, and a member's own real_name edit all survive.
    expect(sql()).toContain('on conflict (lower(nickname)) do nothing;')
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
  it('keeps a fin result that shares everything but category with a meet result', () => {
    // THE BUG 0031 FIXED. The workbook names 2026 수원 연맹회장배 in both the
    // 일반 and the 핀 section on one date, and the pre-0031 key had no category
    // — so the fin swim was silently discarded in favour of the pool one, and a
    // row count could not see it because it counted rows that arrived.
    const { rows, dropped } = dedupeRecords([
      record(),
      record({ category: 'fin', eventName: '같은 날 핀대회' }),
    ])
    expect(rows).toHaveLength(2)
    expect(dropped).toHaveLength(0)
    expect(rows.map((r) => r.category).sort()).toEqual(['fin', 'meet'])
  })

  it('raises on a collision that survives the widened key', () => {
    // Two results identical in member, category, stroke, subcategory, date,
    // distance AND time is the sheet stating one swim twice, or the block walk
    // reading it twice. Keeping the first is what hid the fin bug, so this
    // raises instead — loudly, and before anything is written.
    expect(() => dedupeRecords([record(), record()])).toThrow(DuplicateRecordError)
    expect(() => dedupeRecords([record(), record()])).toThrow(/collide on records_dedup_uq/)
  })

  it('names no member in the duplicate error', () => {
    // The message reaches stderr and gets pasted into issues and PR comments.
    try {
      dedupeRecords([record({ nickname: '홍길동' }), record({ nickname: '홍길동' })])
      throw new Error('expected a DuplicateRecordError')
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicateRecordError)
      expect((error as Error).message).not.toContain('홍길동')
    }
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

describe('double-count guard', () => {
  it('runs inside the transaction and before anything is written', () => {
    const out = sql()
    const guard = out.indexOf('-- Double-count guard.')
    expect(guard).toBeGreaterThan(-1)
    // Inside, so a refusal aborts rather than leaving half an import behind.
    expect(out.indexOf('begin;')).toBeLessThan(guard)
    expect(guard).toBeLessThan(out.indexOf('commit;'))
    // Before every write, the temp table included.
    expect(guard).toBeLessThan(out.indexOf('create temporary table _imp_ctx'))
    expect(guard).toBeLessThan(out.indexOf('insert into public.members'))
  })

  it('reads both counters, since 0016 adds both', () => {
    // 0016:154-157 computes legacy_present + count(present|late) AND
    // legacy_late + count(late). Checking only the attendance column would pass
    // a member whose LATE total is the one already counted, and a doubled 지각왕
    // is small enough to stay plausible — so it would never be questioned.
    //
    // Exercised against the live database on 2026-09-03, all three cases, each
    // inside a rolled-back transaction: (0, 7) raises, (7, 0) raises, (0, 0)
    // passes and reaches the echo after the block. The last one matters — a
    // guard that refuses everything would satisfy the first two.
    const out = sql()
    expect(out).toContain('coalesce(m.historical_attendance_count_legacy, 0)')
    expect(out).toContain('+ coalesce(m.historical_late_count_legacy, 0) <> 0;')
    // The comparison is on the SUM. Were it on either column alone, one of the
    // two single-counter cases above would pass.
    expect(out).not.toContain('historical_attendance_count_legacy, 0) <> 0')
  })

  it('keys on the same lowercased nickname the attendance insert joins on', () => {
    // A guard keyed differently from the write it guards passes exactly the
    // rows the write then loads.
    const out = sql()
    expect(out).toContain('where lower(m.nickname) in (')
    expect(out).toContain('join public.members m on lower(m.nickname) = lower(v.nickname)')
  })

  it('names the members rather than only saying that some exist', () => {
    const out = sql()
    expect(out).toContain("select string_agg(m.nickname, ', ' order by m.nickname)")
    expect(out).toMatch(/raise exception 'refusing to import: the attendance grid names/)
  })

  it('emits nothing at all when there is no attendance to load', () => {
    // No grid, nothing to double-count. An unconditional guard would emit an
    // `in ()` that does not parse.
    const out = toSql({
      members: [],
      trainings: [],
      attendance: [],
      meets: [],
      relays: [],
      warnings: [],
      records: [record()],
    })
    expect(out).not.toContain('-- Double-count guard.')
    expect(out).not.toContain('lower(m.nickname) in (')
  })

  it('escapes a nickname rather than ending the literal', () => {
    const out = toSql({
      members: [],
      trainings: [{ date: '2026-01-03', half: 'H1', label: '1월 3일' }],
      attendance: [{ date: '2026-01-03', nickname: "O'Brien", status: 'present' }],
      meets: [],
      relays: [],
      warnings: [],
      records: [],
    })
    expect(out).toContain("'o''brien'")
  })
})

describe('identity-drift guard', () => {
  it('runs inside the transaction and before anything is written', () => {
    const out = sql()
    const guard = out.indexOf('-- Identity-drift guard.')
    expect(guard).toBeGreaterThan(-1)
    expect(out.indexOf('begin;')).toBeLessThan(guard)
    expect(guard).toBeLessThan(out.indexOf('create temporary table _imp_ctx'))
    expect(guard).toBeLessThan(out.indexOf('insert into public.members'))
  })

  it('matches on real name AND birth date, not either alone', () => {
    // real_name is editable through set_my_real_name, so it is not by itself a
    // safe identity. Requiring both is what keeps a member who corrected their
    // own name from being reported as a duplicate of themselves.
    const out = sql()
    expect(out).toContain('on m.real_name = v.real_name')
    expect(out).toContain('and m.birth_date_text = v.birth_date_text')
    expect(out).toContain('and lower(m.nickname) <> lower(v.nickname)')
  })

  it('ignores sheet rows whose nickname is already a member', () => {
    // Those rows hit `on conflict (lower(nickname)) do nothing` and cannot
    // produce a second copy. Without this clause the guard fires on every run
    // for the pair that legitimately shares a short name.
    expect(sql()).toContain('where not exists (select 1 from public.members e')
  })

  it('says what to do rather than only that something is wrong', () => {
    const out = sql()
    expect(out).toMatch(/raise exception 'refusing to import: the sheet names member\(s\)/)
    expect(out).toContain('rename the existing member')
  })

  it('emits nothing when no member carries both fields', () => {
    const out = toSql({
      members: [
        {
          no: 1,
          nickname: '일',
          sourceRow: 5,
          shortName: '일',
          realName: '',
          birthYear: 1998,
          birthDateText: '',
          gender: '남',
          joinDateText: '',
          joinReason: '',
          lessonLevel: '',
          swimExperience: '',
          notes: '',
        },
      ],
      trainings: [],
      attendance: [],
      meets: [],
      relays: [],
      warnings: [],
      records: [],
    })
    expect(out).not.toContain('-- Identity-drift guard.')
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
