import { STATE, expect, test, waitForScreen } from './fixtures'

/**
 * THE FIRST TEST IN THIS REPOSITORY THAT SENDS BYTES TO STORAGE.
 *
 * That absence is why one defect sat in five features at once. safeObjectName
 * kept Hangul in the object key on purpose, Supabase Storage answers 400
 * InvalidKey for such a key, and so every upload — 미디어, 자료실, 공지 첨부,
 * 결과지, 채팅 — failed for a Korean filename, which here is the ordinary case.
 * Typecheck, 619 unit tests and the browser suite were green throughout, because
 * none of them put an object in a bucket. The bucket held zero objects.
 *
 * A test that stopped at "the row appeared" would have stayed green through all
 * of it. This one requires the object.
 *
 * IT CLEANS UP AFTER ITSELF, and it has to. cleanup.sql cannot: storage's
 * protect_delete() refuses a direct removal from storage.objects, so teardown can
 * drop the media_files row and never the bytes. The note at the foot of
 * cleanup.sql says exactly that and asks whoever adds a media-upload test to
 * sweep properly — this is that. Removing the file through the screen queues its
 * object, and reopening 자료실 runs useObjectDeletionSweep, which drains the
 * queue as the uploader. The run ends with the bucket as it found it.
 */

test.use({ storageState: STATE.member })

// Korean, with a space and a dot, because that is what a member actually picks.
const KOREAN_NAME = '회칙 개정안 2026.txt'

test('uploads a file whose name is Korean, and the object lands', async ({ page }) => {
  await page.goto('/files')
  await waitForScreen(page)

  await page.locator('input[type="file"]').setInputFiles({
    name: KOREAN_NAME,
    mimeType: 'text/plain',
    buffer: Buffer.from('pwtest\n', 'utf8'),
  })

  // THE ASSERTION THAT WOULD HAVE CAUGHT IT. The upload panel renders
  // "N개 파일을 올리지 못했습니다" in a role=alert on failure, and before the key
  // fix that fired every time, with a 400 InvalidKey behind it.
  await expect(page.getByRole('alert')).toHaveCount(0)

  // The row carries the ORIGINAL name — the point of moving the readable name
  // out of the key and into file_name.
  await expect(page.getByText(KOREAN_NAME)).toBeVisible()

  // ---- clean up, because teardown cannot ----
  page.once('dialog', (dialog) => void dialog.accept())
  await page
    .getByRole('listitem')
    .filter({ hasText: KOREAN_NAME })
    .getByRole('button', { name: '삭제' })
    .click()
  await expect(page.getByText(KOREAN_NAME)).toHaveCount(0)

  // Remounting 자료실 runs the sweep, which drains the queued object.
  await page.reload()
  await waitForScreen(page)
})
