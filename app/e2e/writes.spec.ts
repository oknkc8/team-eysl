import {
  SEED,
  STATE,
  expect,
  openAs,
  directRequest,
  test,
  waitForScreen,
} from './fixtures'
import type { Page } from '@playwright/test'

/**
 * The write paths.
 *
 * smoke.spec.ts and flows.spec.ts load screens and read them; nothing in either
 * file changes a row. That leaves the half of the app where every one of the
 * legacy defects lives — attendance that was never saved, comments that
 * overwrote each other, a capacity check the browser made up — completely
 * unverified. Each test below drives one of those paths and then asks the
 * database what it actually holds.
 *
 * Two rules this file follows, both of them learned from tests that lied:
 *
 *  - **The click is not the evidence.** Pressing 저장 and seeing no exception is
 *    exactly what the legacy attendance screen did for years. Every test here
 *    reloads the page, or re-queries the row, or reads it from a second person's
 *    browser, and asserts on what came back.
 *  - **Never assert an absence alone.** `expect(error).toHaveCount(0)` passes
 *    against a screen that has not rendered yet as readily as against one that
 *    worked. Where something must not be there, the test also names something
 *    that must.
 */

// Distinctive enough to find in a failure screenshot, and prefixed so a row that
// escapes cleanup is recognisable in the shared dev database.
const ADMIN_COMMENT = 'pwtest 관리자가 동시에 쓴 댓글'
const MEMBER_COMMENT = 'pwtest 회원이 동시에 쓴 댓글'

/** Far enough out that no seeded fixture shares the date. */
const FUTURE_DATE = '2027-03-14'
const RECORD_DATE = '2026-05-16'
// Typed as a swimmer types it. The screen must read back the same string: the
// stored number is centiseconds, and 3308 rendering as anything but 33.08 means
// the round trip lost the reading.
const RECORD_TIME = '33.08'

/**
 * Chromium logs its own line for every 4xx, whatever the app does with it.
 *
 * A refusal is the expected answer in one test here, so that line says nothing;
 * an exception thrown while rendering the refusal is what would matter. Filtered
 * per-test rather than in fixtures.ts, where it would blind the whole suite to
 * genuinely failed requests.
 */
const withoutHttpErrors = (errors: string[]) => errors.filter((e) => !/status of 4\d\d/.test(e))

/** Parse a PostgREST body, with the raw text in the message when it is not JSON. */
function rows<T>(body: string, what: string): T[] {
  try {
    return JSON.parse(body) as T[]
  } catch {
    throw new Error(`${what}: expected JSON, got ${body.slice(0, 300)}`)
  }
}

// ---------------------------------------------------------------------------
// 1. Two people commenting at once.
// ---------------------------------------------------------------------------

test.describe('공지 댓글', () => {
  test.use({ storageState: STATE.admin })

  /**
   * The legacy defect: addComment() (index.html:2001) read the whole jsonb
   * array, pushed onto its own copy and wrote the array back. Two people
   * commenting in the same minute each wrote a version that did not contain the
   * other's, and whoever saved second silently destroyed the first comment.
   *
   * The rebuild appends a row through append_notice_comment, so there is no
   * array to rewrite. This drives it with two browsers and checks the outcome
   * three ways: both comments render on both screens after a reload, and the
   * table holds exactly two rows with the right two authors.
   *
   * On concurrency, honestly: the two 등록 presses are dispatched together with
   * Promise.all into two separate browser contexts, so the requests overlap, but
   * nothing here forces them to be *simultaneous* at the database. What it does
   * establish is that neither write is built from a copy of the other's state —
   * the property the legacy screen lacked, and the reason its bug did not need
   * perfect timing to fire.
   */
  test('두 회원이 동시에 남긴 댓글이 모두 남는다', async ({ page, consoleWatcher, browser }) => {
    const member = await openAs(browser, STATE.member)

    try {
      await page.goto(`/notices/${SEED.commentNoticeId}`)
      await waitForScreen(page)
      await member.page.goto(`/notices/${SEED.commentNoticeId}`)
      await waitForScreen(member.page)

      // Both drafts typed before either is submitted, so the two writes are the
      // only thing left to happen.
      await page.getByLabel('댓글 입력').fill(ADMIN_COMMENT)
      await member.page.getByLabel('댓글 입력').fill(MEMBER_COMMENT)

      await Promise.all([
        page.getByRole('button', { name: '등록' }).click(),
        member.page.getByRole('button', { name: '등록' }).click(),
      ])

      // 저장됨 waits for the refetch, not merely for the request — the mutation
      // sets it after invalidateQueries resolves.
      await Promise.all([
        expect(page.getByText('저장됨')).toBeVisible({ timeout: 20_000 }),
        expect(member.page.getByText('저장됨')).toBeVisible({ timeout: 20_000 }),
      ])

      // Reloaded so nothing on screen can be a local copy of what this browser
      // just typed. Both comments, on both screens, with both authors named.
      for (const [label, target] of [
        ['총관리자 화면', page],
        ['일반회원 화면', member.page],
      ] as const) {
        await target.reload()
        await waitForScreen(target)
        await expect(target.getByText(ADMIN_COMMENT), `${label}: 관리자 댓글`).toBeVisible()
        await expect(target.getByText(MEMBER_COMMENT), `${label}: 회원 댓글`).toBeVisible()
        await expect(target.getByText('pwtestadmin', { exact: true })).toBeVisible()
        await expect(target.getByText('pwtestmember', { exact: true })).toBeVisible()
      }

      // And what the table holds, asked of the server rather than read off the
      // screen. Two rows: the legacy bug's signature is one.
      const stored = await directRequest(member.page, {
        path: `/rest/v1/notice_comments?notice_id=eq.${SEED.commentNoticeId}&select=body,member_id&order=created_at.asc`,
      })
      expect(stored.status).toBe(200)
      const comments = rows<{ body: string; member_id: string }>(stored.body, 'notice_comments')
      expect(comments.map((c) => c.body).sort()).toEqual([ADMIN_COMMENT, MEMBER_COMMENT].sort())
      expect(new Set(comments.map((c) => c.member_id))).toEqual(
        new Set([SEED.adminMemberId, SEED.memberMemberId]),
      )

      expect(consoleWatcher.errors, '총관리자 콘솔').toEqual([])
      expect(member.console.errors, '일반회원 콘솔').toEqual([])
    } finally {
      await member.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 2. Two people applying for one seat.
// ---------------------------------------------------------------------------

/** Which card the schedule screen settled on, once the refetch has landed. */
async function applicationOutcome(page: Page): Promise<'참가확정' | '대기'> {
  const seated = page.getByText('참가확정', { exact: true })
  // The 대기 heading only; the seat line above reads '신청 1/1 · 대기 1명' and is
  // deliberately not matched by this.
  const waiting = page.getByText(/^대기 (중|\d+번째)$/)
  await expect(seated.or(waiting)).toBeVisible({ timeout: 20_000 })
  return (await seated.count()) > 0 ? '참가확정' : '대기'
}

test.describe('훈련 정원', () => {
  test.use({ storageState: STATE.admin })

  /**
   * The legacy defect: applyTraining() (index.html:2384) compared a cached
   * participant count against capacity in the browser, decided seat or waitlist
   * itself, computed wait_order from that same stale count and posted the
   * verdict. Two people tapping at once both read "0 of 1 taken", both wrote
   * themselves in as participants, and the training was overbooked — or both
   * claimed wait_order 1.
   *
   * The rebuild asks apply_to_activity(), which takes `for update` on the
   * activity row before counting, so the two callers are serialised whatever the
   * browsers believed. This drives both taps together against a 정원 1 activity
   * and checks that the two members ended up on different lists — and, the part
   * the president's members would actually notice, that the one who missed out
   * is *told* they are on the waitlist rather than shown a confirmation.
   *
   * Same honesty note as the comment test: Promise.all overlaps the two
   * requests, it does not guarantee they meet inside the lock. A run where they
   * do not still proves the second caller saw the first one's seat, which is the
   * read the legacy client got wrong.
   */
  test('정원 1명에 두 명이 동시에 신청하면 한 명만 확정된다', async ({ page, browser }) => {
    const first = await openAs(browser, STATE.member)
    const second = await openAs(browser, STATE.member2)
    const path = `/schedule/${SEED.capacityOneActivityId}`

    try {
      for (const actor of [first, second]) {
        await actor.page.goto(path)
        await waitForScreen(actor.page)
        await expect(actor.page.getByRole('button', { name: '신청하기' })).toBeVisible()
      }

      await Promise.all([
        first.page.getByRole('button', { name: '신청하기' }).click(),
        second.page.getByRole('button', { name: '신청하기' }).click(),
      ])

      const settled = await Promise.all([
        applicationOutcome(first.page),
        applicationOutcome(second.page),
      ])

      // Exactly one of each. Two 참가확정 is the overbooking the legacy screen
      // produced; two 대기 would mean nobody got a seat that exists.
      expect(
        settled.filter((o) => o === '참가확정'),
        '참가 확정된 사람',
      ).toHaveLength(1)
      expect(
        settled.filter((o) => o === '대기'),
        '대기로 안내받은 사람',
      ).toHaveLength(1)

      // The waitlisted member must be told so, in the words the screen uses for
      // a live queue — not left reading a confirmation.
      const waitlisted = settled[0] === '대기' ? first : second
      await expect(
        waitlisted.page.getByText(
          '참가자가 취소하거나 앞 순번이 기한을 넘기면 대기 순서대로 자리 안내가 갑니다.',
        ),
      ).toBeVisible()
      await expect(waitlisted.page.getByText('참가확정', { exact: true })).toHaveCount(0)

      // Survives a reload on both sides: the verdict is the stored row, not a
      // thing the tab remembered.
      for (const [index, actor] of [first, second].entries()) {
        await actor.page.reload()
        await waitForScreen(actor.page)
        expect(await applicationOutcome(actor.page), `reload ${index}`).toBe(settled[index])
      }

      // What the server counts, read as the 총관리자, who may see every
      // application row rather than only their own.
      await page.goto(path)
      await waitForScreen(page)
      const stored = await directRequest(page, {
        path: `/rest/v1/activity_applications?activity_id=eq.${SEED.capacityOneActivityId}&select=member_id,application_type,wait_order`,
      })
      expect(stored.status).toBe(200)
      const applications = rows<{
        member_id: string
        application_type: string
        wait_order: number | null
      }>(stored.body, 'activity_applications')

      expect(applications, '신청 행 수').toHaveLength(2)
      expect(
        applications.filter((a) => a.application_type === 'participant'),
        '참가자 행',
      ).toHaveLength(1)
      const queued = applications.filter((a) => a.application_type === 'waitlist')
      expect(queued, '대기자 행').toHaveLength(1)
      // First in the queue, not a duplicate of somebody else's place.
      expect(queued[0]?.wait_order, '대기 순번').toBe(1)
      expect(new Set(applications.map((a) => a.member_id)), '신청한 회원').toEqual(
        new Set([SEED.memberMemberId, SEED.member2MemberId]),
      )

      // The detail card says the same numbers to whoever reads it.
      await expect(page.getByText('신청 1/1')).toBeVisible()
      await expect(page.getByText(/대기 1명/)).toBeVisible()

      expect(first.console.errors, '첫 번째 신청자 콘솔').toEqual([])
      expect(second.console.errors, '두 번째 신청자 콘솔').toEqual([])
    } finally {
      await first.close()
      await second.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 3. Attendance that is actually written down.
// ---------------------------------------------------------------------------

/**
 * One member's card on 출석 체크, so a status assertion names whose status it is.
 *
 * The walk-in test below has two people on screen and every row draws the same
 * three button labels, which makes an unscoped `getByRole('button', { name:
 * '지각' })` either ambiguous or — worse — quietly right about the wrong row.
 *
 * Depends on the shape AdminCheckInPage.tsx:47-71 renders: a card div holding a
 * header div, and the nickname in a `<b>` inside that header. Two ancestors up
 * from the `<b>` is the card. If that nesting changes this stops matching and
 * the test fails loudly, which is why the dependency is written down here.
 */
const rosterCard = (page: Page, nickname: string) =>
  page.getByText(nickname, { exact: true }).locator('xpath=ancestor::div[2]')

test.describe('출석 체크', () => {
  test.use({ storageState: STATE.admin })

  /**
   * The legacy defect, and the most user-visible one in the whole app: setAtt
   * and togglePaid (index.html:3780-3781) mutated an in-memory `attRecords`
   * object and made no database call at all — there was no attendance table to
   * call. Every check-in a coach made poolside was gone the moment the page
   * reloaded.
   *
   * A click-only test would have passed against that code every single time, so
   * this one reloads after each write and asserts the button came back pressed,
   * then reads the same fact off the member's own 내 출석 screen, which goes
   * through a different RPC (attendance_my_history_v1) and a different session.
   */
  test('출석 체크가 새로고침 후에도 남고 회원 화면에도 보인다', async ({
    page,
    consoleWatcher,
    browser,
  }) => {
    const member = await openAs(browser, STATE.member)
    const present = page.getByRole('button', { name: '출석', exact: true })
    const late = page.getByRole('button', { name: '지각', exact: true })

    try {
      await page.goto(`/admin/attendance/${SEED.attendanceActivityId}`)
      await waitForScreen(page)

      // The roster is the activity's participants; seed.sql applied this member
      // so there is somebody to check in.
      await expect(page.getByText('pwtestmember', { exact: true })).toBeVisible()
      await expect(present, '체크 전 출석 버튼').toHaveAttribute('aria-pressed', 'false')

      await present.click()
      await expect(page.getByText('저장됨')).toBeVisible({ timeout: 20_000 })

      // The assertion the legacy code could never have passed.
      await page.reload()
      await waitForScreen(page)
      await expect(present, '새로고침 후 출석 버튼').toHaveAttribute('aria-pressed', 'true')

      // And on the member's own screen, through a different RPC and a different
      // session — so this is not the admin's tab remembering its own tap.
      await member.page.goto('/attendance')
      await waitForScreen(member.page)
      await expect(member.page.getByText(SEED.attendanceActivityTitle)).toBeVisible()
      await expect(member.page.getByText('출석', { exact: true })).toBeVisible()

      // Changing the mark overwrites rather than adding a second row, and the
      // 지각비 control only exists once somebody is marked 지각 — his own
      // togglePaid, which was the other half of the lost state.
      await late.click()
      await expect(page.getByText('저장됨')).toBeVisible({ timeout: 20_000 })
      await page.reload()
      await waitForScreen(page)
      await expect(late, '새로고침 후 지각 버튼').toHaveAttribute('aria-pressed', 'true')
      await expect(present, '지각으로 바꾼 뒤 출석 버튼').toHaveAttribute('aria-pressed', 'false')

      const unpaid = page.getByRole('button', { name: '지각비 미납' })
      await expect(unpaid).toBeVisible()
      await unpaid.click()
      await expect(page.getByText('저장됨')).toBeVisible({ timeout: 20_000 })
      await page.reload()
      await waitForScreen(page)
      await expect(page.getByRole('button', { name: '지각비 납부완료' })).toBeVisible()

      // One row for one member on one activity, not one per tap.
      //
      // Through the RPC, because `attendance` is not a table PostgREST will read
      // at all: it carries no grant to `authenticated` and no RLS policy, so a
      // direct select is 403 even for the 총관리자 (asserted below). Every read
      // of it in the app goes through one of the two SECURITY DEFINER functions,
      // and so does this.
      const stored = await directRequest(page, {
        path: '/rest/v1/rpc/attendance_for_activity_v1',
        method: 'POST',
        body: { p_activity_id: SEED.attendanceActivityId },
      })
      expect(stored.status).toBe(200)
      const marks = rows<{ member_id: string; status: string; late_fee_paid: boolean }>(
        stored.body,
        'attendance_for_activity_v1',
      )
      expect(marks, '명단 행').toHaveLength(1)
      expect(marks[0]?.member_id).toBe(SEED.memberMemberId)
      expect(marks[0]?.status).toBe('late')
      expect(marks[0]?.late_fee_paid).toBe(true)

      expect(consoleWatcher.errors, '출석 관리 콘솔').toEqual([])
      expect(member.console.errors, '내 출석 콘솔').toEqual([])

      // Last on purpose. The closed door itself is worth pinning — so a later
      // migration cannot quietly open the table to direct queries and leave the
      // club's attendance readable by anybody holding the publishable key — but
      // provoking a 403 puts a line in the console that Chromium logs whatever
      // the app does. Asserting the console first keeps that assertion strict
      // instead of filtered.
      const direct = await directRequest(page, {
        path: `/rest/v1/attendance?activity_id=eq.${SEED.attendanceActivityId}&select=member_id`,
      })
      expect(direct.status, '총관리자의 attendance 직접 조회').toBe(403)
    } finally {
      await member.close()
    }
  })

  /**
   * The other half of the same screen, and the defect 0030 fixes.
   *
   * attendance_mark_v1 has never asked whether the member it is handed applied —
   * it checks is_staff() and the status vocabulary and then upserts. The roster
   * read built its result the other way round, `from activity_applications` with
   * attendance LEFT JOINed onto it, so a mark against somebody with no
   * application had nothing to hang on and never came back. The row was stored,
   * the member saw it on 내 출석, team_event_rankings_v1 counted it, and the
   * admin who made the mark was the only reader in the whole system who could
   * not see it — so on the next load they marked the same person again.
   *
   * Driven through the admin screen because the screen is what was lying. The
   * mark itself goes through attendance_mark_v1 rather than through a button,
   * for the same reason the defect could exist: AdminCheckInPage only draws
   * buttons for people the roster already returned, so there is no click that
   * puts a walk-in there. That is not a shortcut around the UI — it is the shape
   * of the bug.
   *
   * Both arms are asserted. `roster` is a UNION of two selects and either side
   * can break alone: lose the attendance arm and the walk-in vanishes again,
   * lose the application arm and every unmarked participant does.
   */
  test('신청하지 않은 회원을 체크해도 운영진 명단에 남는다', async ({ page, consoleWatcher }) => {
    await page.goto(`/admin/attendance/${SEED.walkInActivityId}`)
    await waitForScreen(page)

    // Named positively as well as negatively, per the rule at the head of this
    // file: the applicant proves the roster rendered at all, which is what makes
    // the walk-in's absence here mean "has not been marked yet" rather than
    // "nothing has loaded".
    await expect(page.getByText('pwtestmember', { exact: true }), '체크 전 신청자').toBeVisible()
    await expect(
      page.getByText('pwtestmember2', { exact: true }),
      '체크 전 워크인',
    ).toHaveCount(0)

    // seed.sql deliberately leaves pwtestmember2 out of this activity's
    // applications, so this is a walk-in in the only sense that matters to the
    // function: a member_id the participant list has never heard of.
    const marked = await directRequest(page, {
      path: '/rest/v1/rpc/attendance_mark_v1',
      method: 'POST',
      body: {
        p_activity_id: SEED.walkInActivityId,
        p_member_id: SEED.member2MemberId,
        p_status: 'late',
        p_late_fee_paid: false,
      },
    })
    expect(marked.status, '워크인 출석 기록 응답 코드').toBe(200)

    await page.reload()
    await waitForScreen(page)

    // The assertion the pre-0030 function could not pass: somebody with no
    // application, on the admin's own roster, carrying the status that was set.
    const walkIn = rosterCard(page, 'pwtestmember2')
    await expect(
      walkIn.getByRole('button', { name: '지각', exact: true }),
      '워크인 지각 버튼',
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(
      walkIn.getByRole('button', { name: '출석', exact: true }),
      '워크인 출석 버튼',
    ).toHaveAttribute('aria-pressed', 'false')

    // The application arm, unmarked and still listed. A union that lost this
    // side would leave the coach unable to check in anybody who had not turned
    // up yet, which is most of the roster at the moment they open the screen.
    const applicant = rosterCard(page, 'pwtestmember')
    for (const label of ['출석', '지각', '불참']) {
      await expect(
        applicant.getByRole('button', { name: label, exact: true }),
        `신청자 ${label} 버튼`,
      ).toHaveAttribute('aria-pressed', 'false')
    }

    // Two members, one from each arm, one row each — the UNION deduping rather
    // than a UNION ALL that would list a marked applicant twice.
    const roster = await directRequest(page, {
      path: '/rest/v1/rpc/attendance_for_activity_v1',
      method: 'POST',
      body: { p_activity_id: SEED.walkInActivityId },
    })
    expect(roster.status).toBe(200)
    const listed = rows<{ member_id: string; status: string | null; late_fee_paid: boolean }>(
      roster.body,
      'attendance_for_activity_v1',
    )
    expect(listed, '명단 행').toHaveLength(2)
    // As a map rather than by index, so the assertion says which member holds
    // which status instead of depending on the ORDER BY nickname that put them
    // in this sequence.
    expect(
      new Map(listed.map((row) => [row.member_id, row.status])),
      '명단의 회원별 출석 상태',
    ).toEqual(
      new Map([
        [SEED.memberMemberId, null],
        [SEED.member2MemberId, 'late'],
      ]),
    )
    // coalesce(a.late_fee_paid, false) — the unmarked side has no attendance row
    // to read it from, and a null here would render 지각비 미납 for somebody who
    // was never marked 지각.
    expect(
      listed.map((row) => row.late_fee_paid),
      '지각비 납부 여부',
    ).toEqual([false, false])

    expect(consoleWatcher.errors, '워크인 출석 관리 콘솔').toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 4. A record filed by staff, read by the swimmer.
// ---------------------------------------------------------------------------

test.describe('기록 등록', () => {
  test.use({ storageState: STATE.admin })

  /**
   * Filed on one screen by one person and read on another screen by somebody
   * else. The time is the part worth pinning: result_centiseconds is the
   * canonical column and result_display is only what was typed, so a record
   * entered as 33.08 that comes back as anything else means the round trip
   * through parseSwimTime/formatCentiseconds lost the reading — and a swimmer
   * reading their own best time is the last person who should have to wonder.
   *
   * Filed against pwtestmember2 rather than pwtestmember so it cannot disturb
   * the screens the smoke suite reads for the latter.
   */
  test('관리자가 등록한 기록이 회원 화면에 그대로 보인다', async ({
    page,
    consoleWatcher,
    browser,
  }) => {
    const swimmer = await openAs(browser, STATE.member2)

    try {
      await page.goto('/admin/records/new')
      await waitForScreen(page)

      await page.getByLabel('회원', { exact: true }).selectOption({ label: 'pwtestmember2' })
      // 일반 수영대회 · 개인전 are the form's defaults; pressing them anyway would
      // test the chips rather than the write.
      await page.getByRole('button', { name: '자유형', exact: true }).click()
      await page.getByLabel('거리 (m)').fill('50')
      await page.getByLabel('날짜').fill(RECORD_DATE)
      await page.getByLabel('대회명').fill('pwtest 기록회')
      await page.getByLabel('기록', { exact: true }).fill(RECORD_TIME)

      // The form reads the parsed number back before anything is saved, so a
      // slip is visible before it is on file.
      await expect(page.getByText(`저장될 기록 · ${RECORD_TIME}`)).toBeVisible()

      await page.getByRole('button', { name: '등록' }).click()
      await expect(page.getByText('저장됨')).toBeVisible({ timeout: 20_000 })
      await expect(page.getByText('방금 등록한 기록')).toBeVisible()
      await expect(page.getByText(`${RECORD_DATE.replaceAll('-', '.')} 자유형 50m`)).toBeVisible()

      // The swimmer's own screen, in their own session.
      await swimmer.page.goto('/records')
      await waitForScreen(swimmer.page)
      // exact, because getByText matches case-insensitive substrings by default
      // and the list heading above reads '자유형 50M 개인전 · 1건' — which is a
      // true thing to assert, just not this one.
      await expect(swimmer.page.getByText('자유형 50m', { exact: true })).toBeVisible()
      await expect(swimmer.page.getByRole('heading', { name: '자유형 50M 개인전 · 1건' })).toBeVisible()
      await expect(swimmer.page.getByText(RECORD_TIME).first(), '회원 화면의 기록').toBeVisible()
      await expect(swimmer.page.getByText('pwtest 기록회')).toBeVisible()
      // Their first swim of this event, so the screen says so rather than
      // inventing a delta against nothing.
      await expect(swimmer.page.getByText('첫 기록')).toBeVisible()

      // And the stored row, so "it rendered" and "it is on file" stay separate
      // claims. The centiseconds are what everything else compares.
      const stored = await directRequest(swimmer.page, {
        path: `/rest/v1/records?member_id=eq.${SEED.member2MemberId}&select=stroke,distance_m,result_display,result_centiseconds,created_by`,
      })
      expect(stored.status).toBe(200)
      const filed = rows<{
        stroke: string
        distance_m: number
        result_display: string
        result_centiseconds: number
        created_by: string | null
      }>(stored.body, 'records')
      expect(filed, '저장된 기록 행').toHaveLength(1)
      expect(filed[0]?.result_display).toBe(RECORD_TIME)
      expect(filed[0]?.result_centiseconds).toBe(3308)
      expect(filed[0]?.distance_m).toBe(50)
      // Attributed to the staffer who typed it, not to the swimmer.
      expect(filed[0]?.created_by).toBe(SEED.adminMemberId)

      expect(consoleWatcher.errors, '기록 추가 콘솔').toEqual([])
      expect(swimmer.console.errors, '회원 기록 화면 콘솔').toEqual([])
    } finally {
      await swimmer.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 5. What a member cannot write.
// ---------------------------------------------------------------------------

test.describe('일반회원이 쓸 수 없는 것', () => {
  test.use({ storageState: STATE.member })

  /**
   * The screen's half of the answer: no form, and a sentence saying who may.
   *
   * This is presentation, and the two tests after it are the reason it is only
   * half — the legacy app's whole class of bug was a hidden drawer link standing
   * in for a check.
   */
  test('운영진 일정 수정 화면은 이유를 한국어로 말한다', async ({ page, consoleWatcher }) => {
    await page.goto(`/schedule/${SEED.activityId}/edit`)
    await waitForScreen(page)

    await expect(page.getByText('훈련 일정은 운영진만 수정할 수 있습니다.')).toBeVisible()
    await expect(page.getByRole('link', { name: /일정 보기/ })).toBeVisible()
    // Paired with the two positive assertions above, so this cannot pass against
    // a page that simply has not rendered.
    await expect(page.getByLabel('제목')).toHaveCount(0)

    expect(consoleWatcher.errors, '수정 거절 화면 콘솔').toEqual([])
  })

  /**
   * The database's half, asked from the member's own browser with the member's
   * own session — the request the hidden form would have made.
   *
   * A refused UPDATE under RLS matches no row and returns 200 with an empty
   * array rather than an error, which is precisely the trap deleteActivity()
   * documents: "accepted" is not "applied". So the assertion is on the rows
   * returned *and* on the row still holding its old title.
   */
  test('숨겨진 화면을 우회해도 데이터베이스가 거절한다', async ({ page }) => {
    await page.goto('/')
    await waitForScreen(page)

    const attempt = await directRequest(page, {
      path: `/rest/v1/activities?id=eq.${SEED.activityId}`,
      method: 'PATCH',
      body: { title: 'pwtest 권한 없는 제목' },
    })
    expect(attempt.status, 'PATCH 응답 코드').toBe(200)
    expect(rows(attempt.body, 'activities PATCH'), '일반회원이 고쳐 쓴 훈련 일정 행').toHaveLength(0)

    const after = await directRequest(page, {
      path: `/rest/v1/activities?id=eq.${SEED.activityId}&select=title`,
    })
    expect(after.status).toBe(200)
    expect(rows<{ title: string }>(after.body, 'activities')[0]?.title).toBe(SEED.activityTitle)
  })

  /** The same question of a staff-only RPC, which answers with a refusal rather than silence. */
  test('출석 기록 RPC 는 운영진이 아니면 거절한다', async ({ page }) => {
    await page.goto('/')
    await waitForScreen(page)

    const attempt = await directRequest(page, {
      path: '/rest/v1/rpc/attendance_mark_v1',
      method: 'POST',
      body: {
        p_activity_id: SEED.activityId,
        p_member_id: SEED.memberMemberId,
        p_status: 'present',
        p_late_fee_paid: false,
      },
    })
    expect(attempt.status, 'RPC 응답 코드').toBeGreaterThanOrEqual(400)
    expect(attempt.body, 'RPC 거절 사유').toContain('only staff may mark attendance')

    // Nothing landed. Asked through 내 출석's own RPC, which is the only read of
    // `attendance` anybody has: the table grants nothing to `authenticated` and
    // carries no policy, so a direct select is refused even for staff.
    const history = await directRequest(page, {
      path: '/rest/v1/rpc/attendance_my_history_v1',
      method: 'POST',
      body: {},
    })
    expect(history.status, '내 출석 조회').toBe(200)
    const mine = rows<{ activity_id: string }>(history.body, 'attendance_my_history_v1')
    // Scoped to the activity this test aimed at rather than to the whole
    // history: the attendance test above marks the same member on a different
    // activity, and the two run in parallel.
    expect(
      mine.filter((row) => row.activity_id === SEED.activityId),
      '거절된 뒤 남은 출석 행',
    ).toHaveLength(0)
  })

  /**
   * A refusal that reaches the screen, rather than one the screen pre-empted.
   *
   * Every path above is either the UI declining to draw a form or a request the
   * UI never makes. This is the third case and the one that has to read well: a
   * member holding a form the database will refuse. It happens without anybody
   * doing anything strange — a member files a 기타, a staffer turns it into a
   * 훈련 while the member still has the edit screen open, and the member's save
   * now fails activities_member_event_update's USING clause, which tests the row
   * as it stands.
   *
   * What must appear is 저장 실패 and a way to retry. What must not is a bare
   * PGRST116, and what must not happen at all is 저장됨 over a write the database
   * threw away.
   */
  test('거절된 저장은 화면에 저장 실패로 나타난다', async ({ page, consoleWatcher, browser }) => {
    const staff = await openAs(browser, STATE.admin)

    try {
      // A 기타 of the member's own — the one kind 0015 lets them file.
      await page.goto('/schedule/new')
      await waitForScreen(page)
      await expect(page.getByRole('heading', { name: '기타 등록' })).toBeVisible()
      await page.getByLabel('제목').fill('pwtest 회원이 만든 기타')
      await page.getByLabel('날짜').fill(FUTURE_DATE)
      await page.getByRole('button', { name: '등록' }).click()

      await page.waitForURL(/\/schedule\/[0-9a-f-]{36}$/, { timeout: 20_000 })
      const activityId = new URL(page.url()).pathname.split('/').pop() ?? ''
      expect(activityId, 'the new activity id').toMatch(/^[0-9a-f-]{36}$/)

      // The member opens their own edit form and leaves it sitting there.
      await page.goto(`/schedule/${activityId}/edit`)
      await waitForScreen(page)
      await expect(page.getByLabel('제목')).toHaveValue('pwtest 회원이 만든 기타')

      // Meanwhile a staffer turns it into a 훈련.
      await staff.page.goto(`/schedule/${activityId}/edit`)
      await waitForScreen(staff.page)
      await staff.page.getByRole('button', { name: '훈련', exact: true }).click()
      await staff.page.getByRole('button', { name: '수정', exact: true }).click()
      await staff.page.waitForURL(`**/schedule/${activityId}`, { timeout: 20_000 })

      // The member saves the form they were already holding.
      await page.getByLabel('제목').fill('pwtest 회원이 다시 고친 제목')
      await page.getByRole('button', { name: '수정', exact: true }).click()

      await expect(page.getByText('저장 실패')).toBeVisible({ timeout: 20_000 })
      await expect(page.getByRole('button', { name: '다시 시도' })).toBeVisible()
      // Never the success badge, and never a Postgres error code in the member's
      // face. Both are checked only after 저장 실패 is confirmed on screen, so
      // neither is an absence standing on its own.
      await expect(page.getByText('저장됨')).toHaveCount(0)
      await expect(page.getByText(/PGRST|PostgREST|row-level security/)).toHaveCount(0)
      // Still on the form: a refused save must not navigate as a successful one
      // does.
      await expect(page).toHaveURL(new RegExp(`/schedule/${activityId}/edit$`))

      // And the row kept the staffer's version.
      const stored = await directRequest(staff.page, {
        path: `/rest/v1/activities?id=eq.${activityId}&select=title,kind`,
      })
      const saved = rows<{ title: string; kind: string }>(stored.body, 'activities')
      expect(saved[0]?.kind, '운영진이 바꾼 종류').toBe('training')
      expect(saved[0]?.title, '거절된 뒤의 제목').toBe('pwtest 회원이 만든 기타')

      // The refused write is a 4xx, which Chromium logs regardless; an exception
      // of ours while rendering the failure is what would matter.
      expect(withoutHttpErrors(consoleWatcher.errors), '저장 실패 화면 콘솔').toEqual([])
    } finally {
      await staff.close()
    }
  })
})

// ---------------------------------------------------------------------------
// The two remaining write surfaces, less fraught than the five above.
// ---------------------------------------------------------------------------

test.describe('공지 작성', () => {
  test.use({ storageState: STATE.admin })

  test('새 공지가 목록과 상세에 남는다', async ({ page, consoleWatcher }) => {
    const title = 'pwtest 새로 쓴 공지'
    const body = 'pwtest 공지 본문\n두 번째 줄'

    await page.goto('/notices/new')
    await waitForScreen(page)
    await page.getByLabel('제목').fill(title)
    await page.getByLabel('내용').fill(body)
    await page.getByRole('button', { name: '등록' }).click()

    // The form navigates to the notice it just filed, so the URL is the first
    // evidence the insert returned a row.
    await page.waitForURL(/\/notices\/[0-9a-f-]{36}$/, { timeout: 20_000 })
    const noticeId = new URL(page.url()).pathname.split('/').pop() ?? ''

    // Reloaded: what is on screen now came from the server, not from the cache
    // the mutation seeded.
    await page.reload()
    await waitForScreen(page)
    await expect(page.getByRole('heading', { name: title })).toBeVisible()
    await expect(page.getByText('두 번째 줄')).toBeVisible()

    await page.goto('/notices')
    await waitForScreen(page)
    await expect(page.getByText(title)).toBeVisible()

    const stored = await directRequest(page, {
      path: `/rest/v1/notices?id=eq.${noticeId}&select=title,body,created_by`,
    })
    const saved = rows<{ title: string; body: string; created_by: string | null }>(
      stored.body,
      'notices',
    )
    expect(saved, '저장된 공지 행').toHaveLength(1)
    expect(saved[0]?.title).toBe(title)
    // Line breaks kept: the detail screen relies on them being in the column
    // rather than on markup.
    expect(saved[0]?.body).toContain('\n')
    expect(saved[0]?.created_by).toBe(SEED.adminMemberId)

    expect(consoleWatcher.errors, '공지 작성 콘솔').toEqual([])
  })
})

test.describe('단체 채팅', () => {
  test.use({ storageState: STATE.admin })

  test('보낸 메시지가 상대 화면에도 남는다', async ({ page, consoleWatcher, browser }) => {
    const other = await openAs(browser, STATE.member)
    const message = 'pwtest 단체 채팅 메시지'

    try {
      await page.goto('/chat')
      await waitForScreen(page)
      await page.getByLabel('메시지 입력').fill(message)
      await page.getByRole('button', { name: '보내기' }).click()
      await expect(page.getByText('저장됨')).toBeVisible({ timeout: 20_000 })

      // Reloaded on the sender's side, and read fresh on somebody else's — a
      // message that only exists in the tab that typed it is the failure this
      // rules out. Realtime may or may not have delivered it already; loading
      // the screen from scratch does not depend on that.
      await page.reload()
      await waitForScreen(page)
      await expect(page.getByText(message)).toBeVisible({ timeout: 20_000 })

      await other.page.goto('/chat')
      await waitForScreen(other.page)
      await expect(other.page.getByText(message)).toBeVisible({ timeout: 20_000 })

      expect(consoleWatcher.errors, '보낸 사람 콘솔').toEqual([])
      expect(other.console.errors, '받는 사람 콘솔').toEqual([])
    } finally {
      await other.close()
    }
  })
})
