import { STATE, directRequest, expect, openAs, test, waitForScreen } from './fixtures'
import type { Page } from '@playwright/test'

/**
 * 자유게시판, driven the way a member drives it.
 *
 * Three things here cannot be established any other way, and each one is why a
 * test exists rather than a note:
 *
 *  - **The author's nickname on the list.** listBoardPosts asks PostgREST to
 *    embed member_public_v through board_posts.author_id. That the generated
 *    types accept `member_public_v(nickname)` says the schema cache knows the
 *    relationship, not that a request returns a name — and if it came back as an
 *    array, or empty, every row would read 알 수 없는 회원 and typecheck.
 *  - **The refusals are the database's, not the screen's.** A hidden 수정 button
 *    proves the button is hidden. Each refusal below is also made as the request
 *    the hidden button would have sent, from the signed-in member's own session,
 *    and the answer is asserted.
 *  - **Staff may delete but not edit.** That asymmetry is his (upstream:2639 vs
 *    2668) and it is the kind of thing a later refactor quietly "fixes".
 */

const PREFIX = 'pwtest 자유게시판'
const BODY = '본문입니다.\n두 번째 줄.'

/** The member fixture's id, as seed.sql pins it. */
const MEMBER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

/** Chromium logs a line for every 4xx whatever the app does; a refusal is expected here. */
const withoutHttpErrors = (errors: string[]) => errors.filter((e) => !/status of 4\d\d/.test(e))

/** The browser behind a page, so a spec can open a second context without the fixture. */
function browserOf(page: Page) {
  const browser = page.context().browser()
  if (!browser) throw new Error('page is not attached to a browser')
  return browser
}

/**
 * Write a post through the screens and return the id the URL settled on.
 *
 * Through 글 작성 rather than through the RPC, because the form is half of what
 * these tests are about — and the id comes from the URL rather than from the
 * response, so it is the one the app actually navigated to.
 */
async function writePost(page: Page, title: string): Promise<string> {
  await page.goto('/board')
  await waitForScreen(page)
  await page.getByRole('link', { name: '글 작성' }).click()
  await page.getByLabel('제목').fill(title)
  await page.getByLabel('내용').fill(BODY)
  await page.getByRole('button', { name: '등록하기' }).click()

  await page.waitForURL(/\/board\/[0-9a-f-]{36}$/, { timeout: 20_000 })
  const id = page.url().split('/').pop()
  if (!id) throw new Error(`no post id in ${page.url()}`)
  return id
}

/** Remove a post through the RPC, so a failed assertion still leaves the table clean. */
async function removePost(page: Page, postId: string) {
  await directRequest(page, {
    path: '/rest/v1/rpc/delete_board_post_v1',
    method: 'POST',
    body: { p_post_id: postId },
  })
}

test.describe('자유게시판 — 작성과 목록', () => {
  test.use({ storageState: STATE.member })

  test('회원이 쓴 글이 작성자 닉네임과 함께 목록에 남는다', async ({ page, consoleWatcher }) => {
    const title = `${PREFIX} 작성 ${Date.now()}`
    let postId = ''

    try {
      postId = await writePost(page, title)

      // The detail screen the save landed on.
      await waitForScreen(page)
      await expect(page.getByRole('heading', { name: title })).toBeVisible()
      await expect(page.getByText('두 번째 줄.')).toBeVisible()

      // Reloaded rather than trusted: the copy on screen after a mutation can be
      // the one the client just built. This one came from the server.
      await page.reload()
      await waitForScreen(page)
      await expect(page.getByRole('heading', { name: title })).toBeVisible()
      // The author's own name, read through member_public_v. A post fresh from
      // create_board_post_v1 carries no nickname at all, so this only appears if
      // the refetch and its embed both worked.
      await expect(page.getByText('pwtestmember', { exact: false }).first()).toBeVisible()
      // Not edited yet. Asserted as an absence *beside* a presence, so a screen
      // that failed to render cannot pass it.
      await expect(page.getByText('수정됨')).toHaveCount(0)

      // And on the list, which is the query with the embed in it.
      await page.goto('/board')
      await waitForScreen(page)
      const row = page.getByRole('link', { name: new RegExp(title) })
      await expect(row).toBeVisible()
      await expect(row).toContainText('pwtestmember')

      expect(consoleWatcher.errors).toEqual([])
    } finally {
      if (postId) await removePost(page, postId)
    }
  })

  test('작성자가 고치면 수정됨이 붙고 본문이 바뀐다', async ({ page, consoleWatcher }) => {
    const title = `${PREFIX} 수정 ${Date.now()}`
    const edited = `${title} (고침)`
    let postId = ''

    try {
      postId = await writePost(page, title)
      await waitForScreen(page)

      await page.getByRole('link', { name: '수정' }).click()
      await page.getByLabel('제목').fill(edited)
      await page.getByLabel('내용').fill('고친 본문입니다.')
      await page.getByRole('button', { name: '수정하기' }).click()

      await page.waitForURL(`**/board/${postId}`, { timeout: 20_000 })
      await page.reload()
      await waitForScreen(page)

      await expect(page.getByRole('heading', { name: edited })).toBeVisible()
      await expect(page.getByText('고친 본문입니다.')).toBeVisible()
      // updated_at moved off created_at, which is what update_board_post_v1 sets
      // explicitly — no trigger does it, so a missing `updated_at = now()` would
      // show up exactly here and nowhere else.
      await expect(page.getByText('수정됨')).toBeVisible()

      // The author did not change hands. author_id is not in the RPC's SET list,
      // and this is the assertion that says so out loud.
      const stored = await directRequest(page, {
        path: `/rest/v1/board_posts?id=eq.${postId}&select=author_id,title`,
      })
      expect(stored.status).toBe(200)
      expect(JSON.parse(stored.body)).toEqual([{ author_id: MEMBER_ID, title: edited }])

      expect(consoleWatcher.errors).toEqual([])
    } finally {
      if (postId) await removePost(page, postId)
    }
  })

  test('작성자가 지우면 목록에서 사라진다', async ({ page, consoleWatcher }) => {
    const title = `${PREFIX} 삭제 ${Date.now()}`
    const postId = await writePost(page, title)
    await waitForScreen(page)

    page.once('dialog', (d) => void d.accept())
    await page.getByRole('button', { name: '삭제' }).click()

    await page.waitForURL('**/board', { timeout: 20_000 })
    await waitForScreen(page)
    // The absence, next to the heading that proves the list rendered at all.
    await expect(page.getByRole('heading', { name: '자유게시판' })).toBeVisible()
    await expect(page.getByRole('link', { name: new RegExp(title) })).toHaveCount(0)

    const stored = await directRequest(page, {
      path: `/rest/v1/board_posts?id=eq.${postId}&select=id`,
    })
    expect(JSON.parse(stored.body)).toEqual([])

    expect(consoleWatcher.errors).toEqual([])
  })
})

test.describe('자유게시판 — 남의 글', () => {
  test.use({ storageState: STATE.member })

  test('다른 회원은 수정도 삭제도 못 하고, 서버가 거부한다', async ({ page, consoleWatcher }) => {
    const title = `${PREFIX} 남의글 ${Date.now()}`
    let postId = ''
    const other = await openAs(browserOf(page), STATE.member2)

    try {
      postId = await writePost(page, title)

      await other.page.goto(`/board/${postId}`)
      await waitForScreen(other.page)
      // They can read it — board_posts_read admits any approved member.
      await expect(other.page.getByRole('heading', { name: title })).toBeVisible()
      // But neither control is offered. Beside a presence, so an unrendered
      // screen cannot pass.
      await expect(other.page.getByRole('link', { name: '수정' })).toHaveCount(0)
      await expect(other.page.getByRole('button', { name: '삭제' })).toHaveCount(0)

      // The edit screen by URL, which is the whole reason the route is not
      // staff-guarded: the screen has to refuse for itself.
      await other.page.goto(`/board/${postId}/edit`)
      await waitForScreen(other.page)
      await expect(other.page.getByText('작성자만 수정할 수 있습니다.')).toBeVisible()

      // Now the requests the missing buttons would have sent, from their own
      // session. This is the part a hidden button cannot tell us.
      const rpcUpdate = await directRequest(other.page, {
        path: '/rest/v1/rpc/update_board_post_v1',
        method: 'POST',
        body: { p_post_id: postId, p_title: '가로챈 제목', p_body: '가로챈 본문' },
      })
      expect(rpcUpdate.status).toBe(403)
      expect(rpcUpdate.body).toContain('not your post')

      const rpcDelete = await directRequest(other.page, {
        path: '/rest/v1/rpc/delete_board_post_v1',
        method: 'POST',
        body: { p_post_id: postId },
      })
      expect(rpcDelete.status).toBe(403)
      expect(rpcDelete.body).toContain('not your post')

      // And the table directly, which has no UPDATE or DELETE policy at all. RLS
      // answers these by matching nothing rather than by refusing, so the body
      // is the assertion: an empty array means zero rows changed.
      const patch = await directRequest(other.page, {
        path: `/rest/v1/board_posts?id=eq.${postId}`,
        method: 'PATCH',
        body: { title: '직접 고친 제목' },
      })
      expect(JSON.parse(patch.body)).toEqual([])

      const removed = await directRequest(other.page, {
        path: `/rest/v1/board_posts?id=eq.${postId}`,
        method: 'DELETE',
      })
      expect(JSON.parse(removed.body)).toEqual([])

      // Untouched, asked as the author.
      const stored = await directRequest(page, {
        path: `/rest/v1/board_posts?id=eq.${postId}&select=title`,
      })
      expect(JSON.parse(stored.body)).toEqual([{ title }])

      expect(withoutHttpErrors(consoleWatcher.errors), '작성자 콘솔').toEqual([])
      expect(withoutHttpErrors(other.console.errors), '다른 회원 콘솔').toEqual([])
    } finally {
      if (postId) await removePost(page, postId)
      await other.close()
    }
  })
})

test.describe('자유게시판 — 운영진', () => {
  test.use({ storageState: STATE.member })

  test('운영진은 남의 글을 지울 수 있지만 고칠 수는 없다', async ({ page, consoleWatcher }) => {
    const title = `${PREFIX} 운영진 ${Date.now()}`
    let postId = ''
    const admin = await openAs(browserOf(page), STATE.admin)

    try {
      postId = await writePost(page, title)

      await admin.page.goto(`/board/${postId}`)
      await waitForScreen(admin.page)
      await expect(admin.page.getByRole('heading', { name: title })).toBeVisible()
      // 삭제 yes, 수정 no — his `own || isAdminUser()` on delete (upstream:2668)
      // against an author-only edit (upstream:2639).
      await expect(admin.page.getByRole('button', { name: '삭제' })).toBeVisible()
      await expect(admin.page.getByRole('link', { name: '수정' })).toHaveCount(0)

      // And the database agrees about the half that is refused.
      const rpcUpdate = await directRequest(admin.page, {
        path: '/rest/v1/rpc/update_board_post_v1',
        method: 'POST',
        body: { p_post_id: postId, p_title: '운영진이 고친 제목', p_body: '운영진 본문' },
      })
      expect(rpcUpdate.status).toBe(403)
      expect(rpcUpdate.body).toContain('not your post')

      admin.page.once('dialog', (d) => void d.accept())
      await admin.page.getByRole('button', { name: '삭제' }).click()
      await admin.page.waitForURL('**/board', { timeout: 20_000 })

      const stored = await directRequest(page, {
        path: `/rest/v1/board_posts?id=eq.${postId}&select=id`,
      })
      expect(JSON.parse(stored.body)).toEqual([])
      postId = ''

      expect(withoutHttpErrors(consoleWatcher.errors), '작성자 콘솔').toEqual([])
      expect(withoutHttpErrors(admin.console.errors), '운영진 콘솔').toEqual([])
    } finally {
      if (postId) await removePost(page, postId)
      await admin.close()
    }
  })
})
