import { FIXTURE_NICK_PREFIX } from '../playwright.config'
import { SEED, STATE, expect, openAs, test, waitForScreen } from './fixtures'

/**
 * Training detail, end to end.
 *
 * THE SCREENSHOTS USED TO BE TAKEN HERE and are now in training-detail.shots.ts.
 * They had to move: this is a normal spec, so `npm run test:e2e` runs it, and a
 * run meant only to confirm the app still works was rewriting three committed
 * PNGs every time. Every other screenshot in this suite already lived in a
 * `.shots.ts`, which the chromium project excludes by name — this one file was
 * the hole in that rule, and it was found by noticing three modified images in
 * a working tree after a run that should not have touched them.
 *
 * The reason they are driven rather than hand-taken is unchanged, and the file
 * next door keeps it: a hand-taken shot is a claim nobody re-checks, and
 * asserting before photographing means an empty card fails the test instead of
 * being photographed.
 *
 * WHAT IS NOT TESTED HERE, DELIBERATELY. That `save_activity_details_v1` merges
 * rather than replaces — so a key like historical_attendance survives an edit —
 * cannot be driven from a browser: no client path writes that key, so the test
 * could not plant one to watch it survive. It is proven directly against the
 * database in the PR body instead. A UI test named after that property would
 * assert nothing while claiming to.
 */

const COACH = `${FIXTURE_NICK_PREFIX} 박코치`
const GEAR = `${FIXTURE_NICK_PREFIX} 오리발, 킥판`
const INFO = `${FIXTURE_NICK_PREFIX} 자유형 위주로 진행합니다`
const PLAN = `${FIXTURE_NICK_PREFIX} 1. 웜업 400m\n2. 메인 8x100\n3. 쿨다운 200m`
const LINK = 'https://example.org/pwtest-plan'

// A phone, because that is what a member holds. 430x932 is the iPhone 15 Pro Max
// logical viewport.
test.use({ viewport: { width: 430, height: 932 } })

test.describe('훈련 상세 정보', () => {
  test('staff fills it in and a member reads it back', async ({ browser }) => {
    const admin = await openAs(browser, STATE.admin)
    const page = admin.page

    await page.goto(`/schedule/${SEED.activityId}/edit`)
    await waitForScreen(page)

    await page.locator('#activity-coach').fill(COACH)
    await page.locator('#activity-gear').fill(GEAR)
    await page.locator('#activity-info').fill(INFO)
    await page.locator('#activity-plan').fill(PLAN)
    await page.locator('#activity-link').fill(LINK)

    await expect(page.locator('#activity-coach')).toHaveValue(COACH)

    // '수정' when editing, '등록' when creating — the edit screen's button is not
    // labelled 저장.
    await page.getByRole('button', { name: '수정' }).click()

    // Read back from the server rather than from the form we just typed into —
    // the round trip is the thing under test.
    await page.waitForURL(new RegExp(`/schedule/${SEED.activityId}$`))
    await expect(page.getByText(COACH)).toBeVisible()
    await expect(page.getByText(GEAR)).toBeVisible()
    await expect(page.getByText('웜업 400m')).toBeVisible()

    // A plain member sees the same detail: it is information, not administration.
    const member = await openAs(browser, STATE.member)
    await member.page.goto(`/schedule/${SEED.activityId}`)
    await expect(member.page.getByText(COACH)).toBeVisible()
    await expect(member.page.getByText('쿨다운 200m')).toBeVisible()
    // ...and no 수정 button, because they may not edit it.
    await expect(member.page.getByRole('link', { name: '수정' })).toHaveCount(0)

    // Three lines typed, three lines read back, asserted in the run that wrote
    // them. This was briefly its own test, which passed only because the test
    // above had just saved the plan — a dependency that would have gone unnoticed
    // until somebody ran it alone with -g and watched it fail for no reason.
    const plan = member.page.locator('pre')
    await expect(plan).toContainText('웜업 400m')
    await expect(plan).toContainText('메인 8x100')
    await expect(plan).toContainText('쿨다운 200m')

    await member.close()
    await admin.close()
  })
})
