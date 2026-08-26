import { SEED, STATE, expect, test, waitForScreen } from './fixtures'

/**
 * 다중일 일정 — the calendar, and the edit path that must not lose the range.
 *
 * The second test is the one that earns this file. His app can only create a
 * multi-day race from the Supabase dashboard, and editing it in the app
 * collapses it to a single day, because registerSchedule rebuilds `details`
 * without carrying endDate forward. Ours puts the end date in a column and in
 * ActivityInput, so the same omission is a compile error — but a compile error
 * is a claim about our types, not about what the screen does. This drives the
 * real form and reads the value back out of the database.
 */

test.describe('일정 캘린더', () => {
  test.use({ storageState: STATE.member })

  test('여러 날 대회가 기간의 모든 날짜에 표시된다', async ({ page, consoleWatcher }) => {
    await page.goto('/schedule/calendar')
    await waitForScreen(page)

    await expect(page.getByRole('heading', { name: '일정 캘린더' })).toBeVisible()

    // The fixture's race runs three days inside one month. Each of the three has
    // to find it, and the day before must not — a calendar that shows a race only
    // on its opening day is exactly what the end date exists to fix, and one that
    // smears it across the whole month is the opposite failure.
    for (const day of SEED.multiDayRaceDays) {
      await page.getByRole('button', { name: new RegExp(`^${day}일`) }).click()
      await expect(
        page.getByText(SEED.multiDayRaceTitle),
        `${day}일에 대회가 보여야 한다`,
      ).toBeVisible()
    }

    await page.getByRole('button', { name: new RegExp(`^${SEED.multiDayRaceDayBefore}일`) }).click()
    await expect(
      page.getByText(SEED.multiDayRaceTitle),
      '시작 전날에는 보이지 않아야 한다',
    ).toHaveCount(0)

    expect(consoleWatcher.errors, '콘솔').toEqual([])
  })
})

test.describe('여러 날 일정 수정', () => {
  // Staff: 대회 is staff-only to edit (activities_write), so a member would meet
  // the refusal sentence rather than the form.
  test.use({ storageState: STATE.admin })

  test('다른 항목만 고쳐도 종료일이 남는다', async ({ page, consoleWatcher }) => {
    await page.goto(`/schedule/${SEED.multiDayEditRaceId}/edit`)
    await waitForScreen(page)

    // Read the value rather than hardcoding it: the fixture is seeded relative to
    // current_date, and a test that restated the date would drift with it.
    const before = await page.getByLabel(/종료일/).inputValue()
    expect(before, '픽스처가 실제로 여러 날짜여야 한다').not.toBe('')

    // Change something else entirely, the way a staffer fixing a typo would.
    await page.getByLabel('장소').fill('수정된 수영장')
    // The submit button reads 수정 on an existing activity and 등록 on a new one.
    await page.getByRole('button', { name: '수정' }).click()
    await expect(page.getByText('저장됨')).toBeVisible({ timeout: 20_000 })

    // Reloaded, so this reads what the database kept rather than what the form
    // still had in memory.
    await page.reload()
    await waitForScreen(page)

    await expect(page.getByLabel('장소'), '수정한 항목').toHaveValue('수정된 수영장')
    await expect(page.getByLabel(/종료일/), '종료일이 살아남아야 한다').toHaveValue(before)

    expect(consoleWatcher.errors, '콘솔').toEqual([])
  })

  test('종료일이 시작일보다 빠르면 저장이 막힌다', async ({ page }) => {
    await page.goto(`/schedule/${SEED.multiDayEditRaceId}/edit`)
    await waitForScreen(page)

    const start = await page.getByLabel('날짜').inputValue()

    // One day before the start. The picker's min attribute normally prevents
    // this; fill() bypasses it, which is the point — the guard has to be the
    // client check and the database CHECK, not the widget.
    //
    // Built from local parts and read back as local parts, never through
    // toISOString(): that round-trips via UTC, and midnight in Asia/Seoul is the
    // PREVIOUS day in UTC, so the obvious version of this lands two days early.
    // order.ts opens with the same warning for the same reason.
    const [y, m, d] = start.split('-').map(Number)
    const prev = new Date(y as number, (m as number) - 1, (d as number) - 1)
    const pad = (n: number) => String(n).padStart(2, '0')
    const earlier = `${prev.getFullYear()}-${pad(prev.getMonth() + 1)}-${pad(prev.getDate())}`

    await page.getByLabel(/종료일/).fill(earlier)

    await expect(page.getByText('종료일이 시작일보다 빠릅니다.')).toBeVisible()
    await expect(page.getByRole('button', { name: '수정' })).toBeDisabled()
  })
})
