import { FIXTURE_NICK_PREFIX } from '../playwright.config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SEED, STATE, expect, openAs, test, waitForScreen } from './fixtures'

/**
 * The three 훈련 상세 pictures that go in a PR body.
 *
 * WHY THIS IS A SEPARATE FILE. These used to live in training-detail.spec.ts,
 * which is a normal spec, so `npm run test:e2e` ran them and rewrote three
 * committed PNGs on every run whose only job was to confirm the app still
 * works. The chromium project excludes screenshot files by name, so the file
 * name is what enforces that rule -- not a convention anybody has to remember.
 * Every other screenshot in this suite already lived in a .shots.ts; this one
 * was the hole, found by noticing three modified images in a working tree
 * after a run that should not have touched them.
 *
 * The screenshots are taken here rather than by hand because a hand-taken shot
 * is a claim nobody re-checks. Driving the real screens means the picture and
 * the assertions come from the same run: if the card is empty the test fails
 * before it can photograph an empty card.
 *
 * VIEWPORT CAPTURE, NOT fullPage. The app has a fixed bottom nav; fullPage
 * stretches the page behind it and the nav lands across the middle of the
 * content, which reads as a rendering bug to anyone looking at the PR.
 *
 * The flow duplicates the spec next door on purpose. That is the cheaper half
 * of the split: the alternative was moving the assertions out of the default
 * suite along with the pictures, which would have dropped 훈련 상세 from every
 * regression run.
 *
 * WHAT IS NOT TESTED HERE, DELIBERATELY. That `save_activity_details_v1` merges
 * rather than replaces — so a key like historical_attendance survives an edit —
 * cannot be driven from a browser: no client path writes that key, so the test
 * could not plant one to watch it survive. It is proven directly against the
 * database in the PR body instead. A UI test named after that property would
 * assert nothing while claiming to.
 */

const shotsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'docs',
  'screenshots',
  'training-detail',
)

const COACH = `${FIXTURE_NICK_PREFIX} 박코치`
const GEAR = `${FIXTURE_NICK_PREFIX} 오리발, 킥판`
const INFO = `${FIXTURE_NICK_PREFIX} 자유형 위주로 진행합니다`
const PLAN = `${FIXTURE_NICK_PREFIX} 1. 웜업 400m\n2. 메인 8x100\n3. 쿨다운 200m`
const LINK = 'https://example.org/pwtest-plan'

// A phone, because that is what a member holds. 430x932 is the iPhone 15 Pro Max
// logical viewport.
test.use({ viewport: { width: 430, height: 932 } })

test.describe('훈련 상세 정보 — screenshots', () => {
  test('fill it in, save it, and photograph both sides', async ({ browser }) => {
    const admin = await openAs(browser, STATE.admin)
    const page = admin.page

    await page.goto(`/schedule/${SEED.activityId}/edit`)
    await waitForScreen(page)

    await page.locator('#activity-coach').fill(COACH)
    await page.locator('#activity-gear').fill(GEAR)
    await page.locator('#activity-info').fill(INFO)
    await page.locator('#activity-plan').fill(PLAN)
    await page.locator('#activity-link').fill(LINK)

    // Photographed before saving: this is the screen a staffer actually fills.
    // A filled value is asserted first, because a screenshot of a blank form
    // would look identical to a screenshot of a broken one.
    await expect(page.locator('#activity-coach')).toHaveValue(COACH)
    await page.screenshot({ path: path.join(shotsDir, 'edit-form.png') })

    // '수정' when editing, '등록' when creating — the edit screen's button is not
    // labelled 저장.
    await page.getByRole('button', { name: '수정' }).click()

    // Read back from the server rather than from the form we just typed into —
    // the round trip is the thing under test.
    await page.waitForURL(new RegExp(`/schedule/${SEED.activityId}$`))
    await expect(page.getByText(COACH)).toBeVisible()
    await expect(page.getByText(GEAR)).toBeVisible()
    await expect(page.getByText('웜업 400m')).toBeVisible()
    await page.screenshot({ path: path.join(shotsDir, 'detail-staff.png') })

    // A plain member sees the same detail: it is information, not administration.
    const member = await openAs(browser, STATE.member)
    await member.page.goto(`/schedule/${SEED.activityId}`)
    await expect(member.page.getByText(COACH)).toBeVisible()
    await expect(member.page.getByText('쿨다운 200m')).toBeVisible()
    // ...and no 수정 button, because they may not edit it.
    await expect(member.page.getByRole('link', { name: '수정' })).toHaveCount(0)
    await member.page.screenshot({ path: path.join(shotsDir, 'detail-member.png') })

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
