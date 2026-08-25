import { SEED, STATE, expect, test, waitForScreen } from './fixtures'

/**
 * One test per route in src/app/router.tsx.
 *
 * Each loads the route and asserts two things: a heading the screen can only
 * produce by reaching its own render, and an empty console. The second is what
 * earns this file its keep — React paints a shell for a screen that throws below
 * the fold, so "it looked fine" and "it worked" are different claims, and only
 * the console separates them.
 *
 * A route whose data comes back empty is not a failure here: the dev database is
 * nearly empty by design and every screen is expected to say so in Korean. What
 * fails is a crash, a raw error, or a screen that never leaves its spinner.
 */

type Route = {
  /** The path to visit. */
  path: string
  /** Text the screen renders only if it got as far as its own render. */
  expect: string | RegExp
  /**
   * Narrow `expect` to one kind of element.
   *
   * Only needed where two different controls legitimately carry the same words —
   * see /signup below. Left unset, the assertion is on text alone, which is what
   * most routes want.
   */
  role?: 'button' | 'heading' | 'link'
  /** Why this route sits in this group, when the path does not say it. */
  note?: string
}

// ---------------------------------------------------------------------------
// Public — no session at all.
// ---------------------------------------------------------------------------

test.describe('로그인 없이', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  const routes: Route[] = [
    { path: '/login', expect: 'TEAM EYSL' },
    { path: '/pending', expect: '가입 승인 대기 중' },
    // 가입 신청. The login screen links here, so a person who is not a member
    // yet has exactly one way in and this is it.
    //
    // Anchored, because the bare string matched the intro sentence ("처음이라면
    // 가입 신청을…") as well as the submit button, and Playwright's strict mode
    // fails rather than guessing. Then the segmented 가입 신청 / 로그인 tabs
    // arrived and `^…$` stopped being enough on its own: the tab link's whole
    // text is 가입 신청 too, so an anchored match found two elements again.
    //
    // Both times the screen was fine and the assertion was ambiguous, and both
    // times the answer is the same one this file already reached for — the
    // button is the thing worth asserting, because it is what a new member has
    // to be able to press. Naming its role says that outright instead of relying
    // on it being the only thing that reads this way.
    { path: '/signup', expect: /^가입 신청$/, role: 'button' },
    // The catch-all. Named something no future route will claim.
    { path: '/no-such-route-exists', expect: '페이지를 찾을 수 없습니다' },
  ]

  for (const route of routes) {
    test(`${route.path} 이 렌더된다`, async ({ page, consoleWatcher }) => {
      await page.goto(route.path)
      const target = route.role
        ? page.getByRole(route.role, { name: route.expect })
        : page.getByText(route.expect)
      await expect(target).toBeVisible()
      expect(consoleWatcher.errors, `console on ${route.path}`).toEqual([])
    })
  }

  // Every guarded route funnels through the same redirect, so one representative
  // is enough here; flows.spec.ts tests the guards exhaustively.
  test('보호된 경로는 /login 으로 보낸다', async ({ page, consoleWatcher }) => {
    await page.goto('/notices')
    await page.waitForURL('**/login')
    await expect(page.getByRole('button', { name: '로그인' })).toBeVisible()
    expect(consoleWatcher.errors, 'console while redirecting').toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Every route an approved member may reach.
// ---------------------------------------------------------------------------

const MEMBER_ROUTES: Route[] = [
  { path: '/', expect: /안녕하세요/ },
  { path: '/attendance', expect: '내 출석' },
  { path: '/notices', expect: '공지사항' },
  { path: `/notices/${SEED.noticeId}`, expect: SEED.noticeTitle },
  { path: '/schedule', expect: '일정' },
  {
    path: '/schedule/new',
    // 기타 등록, not 일정 등록: 0015 opened only 기타 to an ordinary member, so
    // creatableKinds() returns one kind and the screen takes the president's own
    // member-facing wording. A staffer with all three kinds sees 새 일정.
    expect: '기타 등록',
  },
  { path: '/schedule/mine', expect: '나의 대회 신청 내역' },
  { path: `/schedule/${SEED.activityId}`, expect: SEED.activityTitle },
  {
    path: `/schedule/${SEED.activityId}/edit`,
    expect: '일정 수정',
    note: 'four RLS policies decide who may save; the screen mirrors them',
  },
  { path: '/events', expect: '이벤트' },
  { path: '/events/attendance', expect: '출석왕' },
  { path: '/events/late', expect: '지각왕' },
  { path: '/events/improve', expect: '단축왕' },
  { path: '/records', expect: '기록' },
  { path: '/members', expect: '회원' },
  { path: `/members/${SEED.memberMemberId}`, expect: 'pwtestmember' },
  {
    path: `/members/${SEED.memberMemberId}/records`,
    expect: /기록/,
    note: 'records_read admits the member themselves, so their own row is readable',
  },
  { path: `/members/${SEED.memberMemberId}/activities/training`, expect: '훈련 신청 내역' },
  { path: `/members/${SEED.memberMemberId}/activities/race`, expect: '대회 참가 현황' },
  { path: `/members/${SEED.memberMemberId}/activities/event`, expect: '기타 참여 현황' },
  { path: '/media', expect: '미디어' },
  { path: `/media/${SEED.folderId}`, expect: SEED.folderName },
  { path: '/files', expect: '자료실' },
  { path: '/chat', expect: '채팅' },
  { path: `/chat/dm/${SEED.adminMemberId}`, expect: 'pwtestadmin' },
  { path: '/settings/notifications', expect: '알림 설정' },
]

test.describe('일반회원으로', () => {
  test.use({ storageState: STATE.member })

  for (const route of MEMBER_ROUTES) {
    test(`${route.path} 이 렌더된다`, async ({ page, consoleWatcher }) => {
      await page.goto(route.path)
      await waitForScreen(page)
      await expect(page.getByText(route.expect).first()).toBeVisible()
      expect(consoleWatcher.errors, `console on ${route.path}`).toEqual([])
    })
  }
})

// ---------------------------------------------------------------------------
// RequireStaff and RequireMasterAdmin, as 총관리자.
// ---------------------------------------------------------------------------

const ADMIN_ROUTES: Route[] = [
  { path: '/admin/attendance', expect: '출석 관리' },
  { path: `/admin/attendance/${SEED.activityId}`, expect: '출석 체크' },
  { path: '/admin/records/new', expect: '기록 추가' },
  {
    path: '/admin/records/upload',
    expect: '결과지 업로드',
    note: 'the one lazy route — SheetJS is ~900kB and must not sit in the main bundle',
  },
  { path: '/notices/new', expect: '새 공지' },
  { path: `/notices/${SEED.noticeId}/edit`, expect: '공지 수정' },
  // RequireMasterAdmin, one level deeper.
  { path: '/members/approval', expect: '가입 승인' },
  { path: '/members/roles', expect: '권한 관리' },
  { path: '/members/blocked', expect: '회원 내보내기' },
]

test.describe('총관리자로', () => {
  test.use({ storageState: STATE.admin })

  for (const route of ADMIN_ROUTES) {
    test(`${route.path} 이 렌더된다`, async ({ page, consoleWatcher }) => {
      await page.goto(route.path)
      await waitForScreen(page)
      await expect(page.getByText(route.expect).first()).toBeVisible()
      expect(consoleWatcher.errors, `console on ${route.path}`).toEqual([])
    })
  }
})
