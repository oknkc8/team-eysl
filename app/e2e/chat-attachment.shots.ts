import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { STATE, expect, test, waitForScreen } from './fixtures'

/**
 * Screenshots for the chat-attachment PR.
 *
 * NOT A TEST, and it is in its own Playwright project so it never runs with the
 * suite. It exists because every PR now carries screenshots, and the alternative
 * — driving a browser from a script of its own — would need a second way to seed
 * the pwtest fixtures and a second copy of the seed-lock protocol. Reusing the
 * harness means there is exactly one of each.
 *
 * It still asserts. A screenshot of a screen that failed to load is worse than
 * no screenshot, because it goes into a PR body looking like evidence.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = path.join(here, '..', '..', 'docs', 'screenshots', 'chat')

test.use({ storageState: STATE.member })

test('chat attachment: pick, send, and see it in the thread', async ({ page }) => {
  await page.goto('/chat')
  await waitForScreen(page)
  // AND the thread has finished loading. waitForScreen only proves the screen
  // painted; the message list is a separate query, and shooting before it
  // resolves puts loading skeletons behind the subject of the frame.
  //
  // THIS USED TO ASSERT THE ROOM WAS EMPTY, and that was wrong in a way only a
  // full run could show. writes.spec.ts:845 sends a pwtest message to this same
  // 단체 채팅 room, so under `--project=screenshots` alone the room was empty and
  // the assertion held, while a whole-suite run put another spec's message in it
  // and this failed. The bug was never in either spec — it was in the pair, and
  // the pair had never run together.
  //
  // So it waits on the absence of the LOADING state rather than the absence of
  // other people's data: AsyncSection renders Shimmer with aria-busy while the
  // query is pending, and that is true or false regardless of what the room
  // holds. Asserting emptiness is asserting something no spec here owns.
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0)

  // A file that is its own explanation when someone opens the PNG and wonders
  // what was uploaded. Built here rather than committed: a fixture file in the
  // repo would be one more thing to keep in step with this spec.
  const upload = {
    name: '훈련일지.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('pwtest 첨부 파일\n', 'utf8'),
  }

  // 1. The composer with a file chosen and not yet sent. This is the state the
  //    feature adds — before it, there was no way to reach it at all.
  await page.getByRole('button', { name: '파일 첨부' }).click()
  await page.locator('input[type="file"]').setInputFiles(upload)
  await expect(page.getByTitle(upload.name)).toBeVisible()
  await page.getByLabel('메시지 입력').fill('오늘 훈련일지 첨부합니다')
  await page.screenshot({ path: path.join(SHOTS, 'composer-with-file.png') })

  // 2. Sent, and rendered in the thread as an attachment somebody can open.
  await page.getByRole('button', { name: '보내기' }).click()

  // WAIT FOR THE SERVER ROW, not for the text. The optimistic bubble carries the
  // same words the moment the button is clicked, so asserting on the text alone
  // is satisfied by the pending copy — the first run of this spec captured
  // exactly that: a frame reading 보내는 중 / 저장 중… with no attachment on it,
  // and the assertion passed. A screenshot that goes into a PR looking like
  // evidence has to be of the state it claims to show.
  //
  // 보내는 중 is what MessageThread renders in place of the timestamp while a
  // bubble is still pending, so its absence is the send completing.
  await expect(page.getByText('보내는 중')).toHaveCount(0)
  // And the OBJECT landed, which is the whole point of the frame. `저장됨` is
  // what the composer shows when sendMessage returned uploadFailed: false — a
  // failed upload renders `저장 실패` instead, so this distinguishes the two.
  //
  // NOT asserted on the file name: MessageThread labels an attachment with the
  // message body when there is one (caption={message.body}), so a captioned
  // message never displays its file name. That is why the earlier version of
  // this line failed — it looked for a string the screen had no reason to show.
  await expect(page.getByText('저장됨')).toBeVisible()

  // AND the attachment has finished resolving. Its URL is signed on demand, so
  // the bubble reads `첨부파일 불러오는 중…` until that query returns — which is
  // what the previous version of this frame captured. Three times now this spec
  // has photographed a transient state that satisfied its own assertion; the
  // rule it keeps teaching is that the thing to wait for is the thing you intend
  // to show, not a proxy that happens to be true earlier.
  await expect(page.getByText('첨부파일 불러오는 중…')).toHaveCount(0)
  await page.screenshot({ path: path.join(SHOTS, 'sent-in-thread.png') })
})

test('chat attachment: a file with no caption is a message', async ({ page }) => {
  await page.goto('/chat')
  await waitForScreen(page)
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0)

  // send_message_v1 takes text OR an attachment, so the send button must enable
  // on a file alone. Worth its own frame: it is the rule most likely to be
  // "simplified" away by someone who assumes a message needs words.
  await page.getByRole('button', { name: '파일 첨부' }).click()
  await page.locator('input[type="file"]').setInputFiles({
    name: '기록표.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('pwtest\n', 'utf8'),
  })
  await expect(page.getByRole('button', { name: '보내기' })).toBeEnabled()
  await page.screenshot({ path: path.join(SHOTS, 'file-only-can-send.png') })
})
