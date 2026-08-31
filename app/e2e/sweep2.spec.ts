import { SEED, STATE, directRequest, expect, test, waitForScreen } from './fixtures'

/**
 * Round two: the write paths and the cascades, not the renders.
 *
 * Round one proved these five screens paint. Painting is the cheapest thing a
 * screen can get right. What no test has ever done is press the buttons on them
 * and then go and look somewhere else to see whether the thing happened.
 *
 * Every test here cleans up after itself, because the dev database is shared
 * with three other agents' suites.
 */

// ---------------------------------------------------------------------------
// 글쓰기: the only route by which a member writes anything, and no spec has
// ever submitted the form.
// ---------------------------------------------------------------------------

test.describe('자유게시판 글쓰기 — 쓰고, 목록에 나타나고, 지워지는가', () => {
  test.use({ storageState: STATE.member })

  test('빈 폼은 저장되지 않고 이유를 말한다', async ({ page, consoleWatcher }) => {
    await page.goto('/board/new')
    await waitForScreen(page)

    // The screen does better than refusing on submit: 등록하기 is disabled until
    // both fields have content (BoardEditPage:188, disabled={!canSubmit}). My
    // first draft clicked it and timed out, which read as a broken button and
    // was actually the guard working.
    await expect(page.getByRole('button', { name: '등록하기' })).toBeDisabled()
    await page.getByLabel('제목').fill('pwtest 제목만')
    await expect(page.getByRole('button', { name: '등록하기' })).toBeDisabled()
    expect(consoleWatcher.errors, 'console on empty submit').toEqual([])
  })

  test('쓴 글이 목록과 상세에 나타나고, 지우면 사라진다', async ({ page, consoleWatcher }) => {
    const title = `pwtest sweep ${Date.now()}`
    let postId = ''

    // try/finally, because board.spec.ts wraps all eight of its write tests and
    // this one did not. The assertion this test exists FOR (does the post reach
    // the list) is also the one most likely to fail, and without the finally a
    // failure there dies before the delete and leaves a row behind on a
    // database three other suites are using.
    try {
      await page.goto('/board/new')
      await waitForScreen(page)
      await page.getByLabel('제목').fill(title)
      await page.getByLabel('내용').fill('pwtest 본문입니다.')
      await page.getByRole('button', { name: '등록하기' }).click()
      // Wait for the app to land on the new post before navigating away.
      // Without this the goto below aborts the in-flight mutation and the list
      // comes up empty, which reads exactly like "the write silently failed"
      // and is really a race in the test. board.spec.ts:54 waits the same way.
      await page.waitForURL(/\/board\/[0-9a-f-]{36}$/, { timeout: 20_000 })
      postId = page.url().split('/').pop() ?? ''

      // THE CASCADE, and the reason this test exists: the write is not the
      // claim, the list is. A create that returns 200 and never appears is the
      // shape of defect this whole track is looking for.
      await page.goto('/board')
      await waitForScreen(page)
      await expect(page.getByText(title)).toBeVisible({ timeout: 15_000 })

      await page.getByText(title).first().click()
      await waitForScreen(page)
      await expect(page.getByRole('heading', { name: title })).toBeVisible()

      page.once('dialog', (d) => void d.accept())
      await page.getByRole('button', { name: '삭제' }).first().click()

      await page.waitForURL('**/board', { timeout: 20_000 })
      await waitForScreen(page)
      await expect(page.getByRole('link', { name: new RegExp(title) })).toHaveCount(0)
      // Deleted through the UI, which is what this test came to prove, so the
      // finally has nothing left to do.
      postId = ''
    } finally {
      if (postId) {
        await directRequest(page, {
          path: '/rest/v1/rpc/delete_board_post_v1',
          method: 'POST',
          body: { p_post_id: postId },
        })
      }
    }

    expect(consoleWatcher.errors, 'console across the board lifecycle').toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 명단 추가: staff enrolling a member who cannot sign in. Shipped two days ago,
// exercised in a browser by nothing.
// ---------------------------------------------------------------------------

test.describe('명단 추가 — 패널이 실제 후보를 가져오는가', () => {
  test.use({ storageState: STATE.admin })

  // READ-ONLY, and the reason is the finding.
  //
  // The panel lists every approved member with no login — which on this
  // database is 36 REAL club members, not fixtures. My first draft picked the
  // first row and pressed 추가, i.e. it was one click away from enrolling a
  // real person into a pwtest training. seed.sql has no member without a login,
  // so there is no safe row to write to.
  //
  // A write test here needs a seeded no-login member. That belongs in seed.sql,
  // which the e2e harness owns and another agent is actively changing, so it is
  // reported rather than added here.
  test('패널이 후보 목록이나 빈 상태를 돌려준다', async ({ page, consoleWatcher }) => {
    await page.goto('/admin/applications')
    await waitForScreen(page)

    await page.getByRole('button', { name: '명단 추가' }).first().click()

    // exact:true — Playwright matches accessible names by substring, so
    // { name: '추가' } also matches the panel's own 명단 추가 button, and
    // clicking that closes the panel it just opened.
    const add = page.getByRole('button', { name: '추가', exact: true }).first()
    const nobody = page.getByText('추가할 수 있는 회원이 없습니다')

    await expect(add.or(nobody).first()).toBeVisible({ timeout: 15_000 })
    expect(consoleWatcher.errors, 'console after opening 명단 추가').toEqual([])
  })
})

// ---------------------------------------------------------------------------
// A claim the screen makes about blocking. Read-only: this asserts the SENTENCE
// is on screen, and leaves the blocking itself to writes.spec.ts, which already
// owns that fixture.
// ---------------------------------------------------------------------------

test.describe('회원 내보내기 안내문', () => {
  test.use({ storageState: STATE.admin })

  test('내보내기 설명이 화면에 있다', async ({ page, consoleWatcher }) => {
    await page.goto('/members/blocked')
    await waitForScreen(page)

    // The sentence is in a window.confirm (MemberAccessPage:66-70), not in the
    // document — my first draft looked for it in the DOM and failed. Dismissing
    // the dialog leaves the member untouched, so this reads the promise without
    // blocking anybody on a shared database.
    let asked = ''
    page.once('dialog', (d) => {
      asked = d.message()
      void d.dismiss()
    })
    const kick = page.getByRole('button', { name: '내보내기' }).first()
    if (!(await kick.isVisible().catch(() => false))) {
      test.skip(true, 'no blockable member in this database')
      return
    }
    await kick.click()
    await expect.poll(() => asked, { timeout: 10_000 }).toContain('기록·출석·신청 내역은 지워지지 않으며')
    expect(consoleWatcher.errors, 'console on /members/blocked').toEqual([])
  })
})

test.describe('스윕이 남긴 것이 없어야 한다', () => {
  test.use({ storageState: STATE.admin })

  test('seed 훈련은 그대로 남아 있다', async ({ page }) => {
    await page.goto(`/schedule/${SEED.activityId}`)
    await waitForScreen(page)
    await expect(page.getByText(SEED.activityTitle)).toBeVisible({ timeout: 15_000 })
  })
})
