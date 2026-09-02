import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { SEED, STATE, expect, test, waitForScreen } from './fixtures'

/**
 * Screenshots for the activity-comments PR (0050).
 *
 * NOT A TEST, and it is in its own Playwright project so it never runs with
 * the suite — same reasoning as chat-attachment.shots.ts, reusing the harness
 * rather than a second way to seed the pwtest fixtures.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = path.join(here, '..', '..', 'docs', 'screenshots', 'activity-comments')

test.use({ storageState: STATE.member })

test('activity comments: write one and see it on the thread', async ({ page }) => {
  await page.goto(`/schedule/${SEED.commentActivityId}`)
  await waitForScreen(page)
  await expect(page.getByRole('heading', { name: SEED.commentActivityTitle })).toBeVisible()

  // 1. The activity detail page with the comment form, before anything is
  //    typed — the state that did not exist until this feature did.
  await page.screenshot({ path: path.join(SHOTS, 'activity-detail-with-comments.png') })

  const body = '내일 준비물이 뭔가요? 수모만 챙기면 될까요?'
  await page.getByLabel('댓글 입력').fill(body)
  await page.getByRole('button', { name: '등록' }).click()

  // WAIT FOR THE SERVER ROW, not for the text — the same trap
  // chat-attachment.shots.ts documents. appendActivityComment returns nothing
  // on purpose, so the visible comment comes from a refetch, and a screenshot
  // taken between the click and that refetch shows 저장 중 with the empty-state
  // card still on screen — a frame photographed here once and caught by eye,
  // not by an assertion, which is exactly why these three are asserted rather
  // than trusted.
  await expect(page.getByText('저장 중')).toHaveCount(0)
  await expect(page.getByText('아직 댓글이 없습니다')).toHaveCount(0)
  await expect(page.locator('.comment .body', { hasText: body })).toBeVisible()
  await expect(page.getByLabel('댓글 입력')).toHaveValue('')

  // 2. The thread with a real comment on it, nickname and relative time
  //    attached — the part a hidden delete-less UI cannot show on its own.
  await page.screenshot({ path: path.join(SHOTS, 'comment-posted.png') })
})
