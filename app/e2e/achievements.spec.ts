import { STATE, expect, test, waitForScreen } from './fixtures'

/**
 * 나의 성과·배지, 월간 활동 요약, and the medal ranking badges — the three
 * screens 0034 stands behind.
 *
 * smoke.spec.ts already loads these routes and checks the console. This file
 * asks the harder question: not "did the screen render" but "did the RIGHT
 * NUMBERS arrive". A jsonb payload that is wrong but type-compatible passes
 * every typecheck and every unit test in the repo — parseAchievement narrows
 * whatever it is handed, and a moment list that came back as an object rather
 * than an array reads as empty, which is a legitimate state the screen has a
 * sentence for. Only a real browser against real rows tells the two apart.
 *
 * The fixture is in seed.sql: five attendance marks (one of them 지각) and three
 * swims of one event across two years, chosen so every assertion below fails if
 * a rule in 0034 is wrong rather than merely if the screen is blank.
 */

// The fixture is seeded relative to current_date, and the server reports the
// year in Asia/Seoul — which is also the timezone playwright.config pins, so the
// two agree.
const YEAR = new Date().getFullYear()

test.describe('나의 성과 · 배지', () => {
  test.use({ storageState: STATE.member })

  test('마이페이지에 배지와 PB 모먼트가 실제 값으로 그려진다', async ({ page, consoleWatcher }) => {
    await page.goto('/mypage')
    await waitForScreen(page)

    await expect(page.getByText('나의 출석 배지')).toBeVisible()

    // FIVE, and the fixture's fifth mark is a 지각. If my_achievement_v1 counted
    // 출석 only this would read 4회 and the tier below would still be locked, so
    // this single line is what holds the 지각 rule in place end to end.
    await expect(page.getByText(`${YEAR}년 누적 5회`), '연간 누적').toBeVisible()
    await expect(page.getByText('다음 배지 10회까지 5회 남음'), '진행 상황').toBeVisible()

    // The unlocked tier shows its message; the ones above it withhold theirs.
    // Both halves are asserted because final73-badge-reveal is the difference
    // between them, and a reveal that leaked would still render "a message".
    await expect(page.getByText('팀아이슬, 이제 익숙해졌죠?'), '5회 배지 문구').toBeVisible()
    await expect(page.getByText('아이슬 포세이돈'), '25회 배지 문구는 숨는다').toHaveCount(0)
    await expect(page.getByText('달성하면 공개!').first(), '잠긴 배지').toBeVisible()

    // Two moments, newest first. The second one's old_pb is the first one's
    // new_pb: that chain is the window frame in 0034 looking back over every
    // earlier day rather than only at last year.
    await expect(page.getByText('PB 모먼트')).toBeVisible()
    const moments = page.locator('.pbCard')
    await expect(moments, 'PB 모먼트 카드 수').toHaveCount(2)

    await expect(moments.nth(0)).toContainText('38.50 → 37.25')
    await expect(moments.nth(0)).toContainText('▼ 1.25초 단축')
    await expect(moments.nth(1)).toContainText('40.00 → 38.50')
    await expect(moments.nth(1)).toContainText('▼ 1.50초 단축')

    // The distance is ours, not his — his card prints the stroke alone, which
    // renders a 50 and a 100 as the same row twice.
    await expect(moments.nth(0)).toContainText('NEW PB · 자유형 50M')

    // A card names the meet where the PB was SET, not the one the old time came
    // from: this moment happened at 봄 대회 and beat a time swum 작년.
    await expect(moments.nth(1)).toContainText('pwtest 봄 대회')

    // And the 작년 swim itself produces no card. Nothing precedes it, so it is a
    // baseline rather than a moment — the rule that keeps a first-ever swim from
    // rendering as "0.00 → 40.00", a 40-second regression. The count of 2 above
    // implies this; naming the meet that must be absent says which of the three
    // swims was dropped, and why.
    await expect(page.getByText('pwtest 작년 대회'), '기준 기록은 카드가 아니다').toHaveCount(0)

    expect(consoleWatcher.errors, '콘솔').toEqual([])
  })
})

test.describe('월간 활동 요약', () => {
  test.use({ storageState: STATE.member })

  test('달을 옮기면 그 달의 집계가 바뀐다', async ({ page, consoleWatcher }) => {
    await page.goto('/activity')
    await waitForScreen(page)

    await expect(page.getByRole('heading', { name: '월간 활동 요약' })).toBeVisible()

    // The page opens on the current month. The fixture puts nothing there, so
    // this is the empty sentence — worth asserting, because 0회 for every metric
    // and a crashed fetch look identical if you only check that the stats grid
    // exists.
    await expect(page.getByText('이번 달 등록된 활동 내역이 없습니다.')).toBeVisible()

    // Step back to July, where the fixture put two rank-day trainings: 7/20
    // 출석 and 7/30 지각.
    const currentMonth = new Date().getMonth() + 1
    for (let step = currentMonth; step > 7; step -= 1) {
      await page.getByRole('button', { name: '이전 달' }).click()
    }

    await expect(page.getByText(`${YEAR}년 7월`)).toBeVisible()
    await expect(page.getByText('7월에는 훈련 2회, 대회 0회, 기타 0회에 참여했어요.')).toBeVisible()

    // 지각 counts toward the rate as well as toward the badge, so two marks of
    // which one is late is still 100% — the rate measures whether you turned up,
    // not whether you were punctual. 지각왕 answers the other question.
    await expect(page.getByText('출석 체크된 2회 중 2회 참석했어요.')).toBeVisible()

    expect(consoleWatcher.errors, '콘솔').toEqual([])
  })
})

test.describe('메달 · 등급', () => {
  test.use({ storageState: STATE.member })

  test('랭킹 1위에 금메달이 붙고 전체 랭킹을 펼칠 수 있다', async ({ page, consoleWatcher }) => {
    await page.goto('/events/attendance')
    await waitForScreen(page)

    await expect(page.getByRole('heading', { name: '출석왕' })).toBeVisible()

    // The badge keeps the rank in its aria-label even though it paints a medal,
    // so this locates the podium by meaning and then checks the glyph. A screen
    // reader gets "1위"; everybody else gets 🥇.
    const first = page.getByLabel('1위').first()
    await expect(first).toBeVisible()
    await expect(first, '1위 뱃지').toHaveText('🥇')

    // The dev database has more than five ranked members, so the list collapses.
    const toggle = page.getByRole('button', { name: '전체 랭킹 보기' }).first()
    await expect(toggle).toBeVisible()

    const rowsBefore = await page.locator('ol li').count()
    await toggle.click()
    await expect(page.getByRole('button', { name: 'TOP5만 보기' }).first()).toBeVisible()
    expect(await page.locator('ol li').count(), '펼친 뒤 행 수').toBeGreaterThan(rowsBefore)

    expect(consoleWatcher.errors, '콘솔').toEqual([])
  })
})
