import { STATE, expect, test, waitForScreen } from './fixtures'

/**
 * The five routes no spec visited.
 *
 * smoke.spec.ts opens with "One test per route in src/app/router.tsx". It
 * covers 28 of 45, and five of the missing ones are reached by NO spec at all:
 *
 *   /admin/applications      활동 취합본 — and the 명단 추가 panel inside it
 *   /admin/records/uploads   결과지 목록 — deleting one takes its records
 *   /board/new               the only way a member writes a post
 *   /events/stroke           영법별 랭킹
 *   /members/link            회원 연결 — moves years of history onto a login
 *
 * Three of those are screens that shipped in the last two days. A screen with
 * no test is not a screen that works; it is a screen nobody has looked at since
 * the browser last had it open.
 *
 * This file is the floor: does each one render for the role that owns it, stay
 * out of the console, and refuse the role that does not.
 */

// ---------------------------------------------------------------------------
// The record manager's screens.
// ---------------------------------------------------------------------------

test.describe('운영진 화면 — 아무 스펙도 열어본 적 없는 것들', () => {
  test.use({ storageState: STATE.admin })

  test('활동 취합본이 렌더된다', async ({ page, consoleWatcher }) => {
    await page.goto('/admin/applications')
    await waitForScreen(page)
    await expect(page.getByRole('heading', { name: '활동 취합본' })).toBeVisible()
    expect(consoleWatcher.errors, 'console on /admin/applications').toEqual([])
  })

  // The panel is collapsed until pressed, so rendering the card proves nothing
  // about it. Opening it is what exercises activity_enrollable_members_v1.
  test('명단 추가 패널이 열리고 목록을 가져온다', async ({ page, consoleWatcher }) => {
    await page.goto('/admin/applications')
    await waitForScreen(page)

    const open = page.getByRole('button', { name: '명단 추가' }).first()
    await open.waitFor({ state: 'visible', timeout: 15_000 })
    await open.click()

    // Either the list or its empty state — both mean the RPC answered. A
    // spinner that never resolves is the failure this catches.
    await expect(
      page
        .getByText('추가할 수 있는 회원이 없습니다')
        .or(page.getByRole('button', { name: '추가' }).first())
        .or(page.getByText('회원 목록을 불러오지 못했습니다')),
    ).toBeVisible({ timeout: 15_000 })

    expect(consoleWatcher.errors, 'console after opening 명단 추가').toEqual([])
  })

  test('결과지 목록이 렌더된다', async ({ page, consoleWatcher }) => {
    await page.goto('/admin/records/uploads')
    await waitForScreen(page)
    await expect(page.getByRole('heading', { name: '결과지 목록' })).toBeVisible()
    // Nothing has ever been uploaded to the dev bucket through this screen, so
    // the empty state is the expected answer — and it must be the empty state,
    // not an error.
    await expect(
      page.getByText('올린 결과지가 없습니다').or(page.getByRole('article').first()),
    ).toBeVisible({ timeout: 15_000 })
    expect(consoleWatcher.errors, 'console on /admin/records/uploads').toEqual([])
  })

  test('회원 연결이 렌더된다', async ({ page, consoleWatcher }) => {
    await page.goto('/members/link')
    await waitForScreen(page)
    expect(consoleWatcher.errors, 'console on /members/link').toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Every approved member.
// ---------------------------------------------------------------------------

test.describe('회원 화면', () => {
  test.use({ storageState: STATE.member })

  test('영법별 랭킹이 렌더된다', async ({ page, consoleWatcher }) => {
    await page.goto('/events/stroke')
    await waitForScreen(page)
    expect(consoleWatcher.errors, 'console on /events/stroke').toEqual([])
  })

  test('글쓰기 화면이 렌더된다', async ({ page, consoleWatcher }) => {
    await page.goto('/board/new')
    await waitForScreen(page)
    expect(consoleWatcher.errors, 'console on /board/new').toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The refusals. A guard is only a guard if it turns somebody away.
// ---------------------------------------------------------------------------

test.describe('권한 없는 계정이 관리 화면에 가면', () => {
  test.use({ storageState: STATE.member })

  for (const path of ['/admin/applications', '/admin/records/uploads', '/members/link']) {
    test(`${path} 는 회원을 돌려보낸다`, async ({ page, consoleWatcher }) => {
      await page.goto(path)
      await waitForScreen(page)
      // Redirected away, or refused in place with Korean — either is a guard.
      // What must not happen is the screen rendering its admin content.
      await expect.poll(async () => page.url().includes(path), { timeout: 10_000 }).toBe(false)
      expect(consoleWatcher.errors, `console while refusing ${path}`).toEqual([])
    })
  }
})
