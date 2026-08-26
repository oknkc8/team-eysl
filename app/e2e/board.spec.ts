import { APP_ENV, STATE, directRequest, expect, openAs, test, waitForScreen } from './fixtures'
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

/**
 * A request carrying the publishable key and NO session, which is what a
 * stranger with the bundle in their browser can send.
 *
 * directRequest cannot express this: it reads the page's own token and attaches
 * it, which is the whole point of it everywhere else. anon is the one caller
 * that has no token to read.
 */
async function anonRequest(
  page: Page,
  init: { path: string; method?: string; body?: unknown },
): Promise<{ status: number; body: string }> {
  return page.evaluate(
    async ({ base, key, req }) => {
      const response = await fetch(`${base}${req.path}`, {
        method: req.method ?? 'GET',
        headers: {
          apikey: key,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
      })
      return { status: response.status, body: await response.text() }
    },
    { base: APP_ENV.url, key: APP_ENV.key, req: init },
  )
}

/** The current `updated_at` of a post, as the version an editor would be holding. */
async function versionOf(page: Page, postId: string): Promise<string> {
  const read = await directRequest(page, {
    path: `/rest/v1/board_posts?id=eq.${postId}&select=updated_at`,
  })
  const rows = JSON.parse(read.body) as { updated_at: string }[]
  const version = rows[0]?.updated_at
  if (!version) throw new Error(`no post at ${postId}: ${read.body}`)
  return version
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

test.describe('자유게시판 — 두 탭에서 같은 글', () => {
  test.use({ storageState: STATE.member })

  /**
   * The lost update, which 0033 had and 0037 closes.
   *
   * Both tabs are the SAME member, because that is who this happens to: editing
   * is author-only, so the two writers in a board conflict are always one person
   * on two devices. Under 0033 the second save overwrote the first and both
   * reported success — verified against the dev database by re-installing that
   * version and watching tab B's text disappear.
   */
  test('나중에 저장한 쪽이 먼저 저장한 글을 덮어쓰지 않는다', async ({ page, consoleWatcher }) => {
    const title = `${PREFIX} 두탭 ${Date.now()}`
    let postId = ''
    const tabB = await openAs(browserOf(page), STATE.member)

    try {
      postId = await writePost(page, title)

      // Both tabs open the editor on the same version.
      await page.goto(`/board/${postId}/edit`)
      await waitForScreen(page)
      await tabB.page.goto(`/board/${postId}/edit`)
      await waitForScreen(tabB.page)

      // Tab B saves first and lands on the post.
      await tabB.page.getByLabel('제목').fill(`${title} B`)
      await tabB.page.getByLabel('내용').fill('B가 먼저 저장한 본문입니다.')
      await tabB.page.getByRole('button', { name: '수정하기' }).click()
      await tabB.page.waitForURL(`**/board/${postId}`, { timeout: 20_000 })

      // Tab A now saves the version it loaded before B wrote.
      await page.getByLabel('제목').fill(`${title} A`)
      await page.getByLabel('내용').fill('A가 나중에 저장한 본문입니다.')
      await page.getByRole('button', { name: '수정하기' }).click()

      // Refused, and told why — beside B's text, so the member can decide.
      await expect(page.getByText('다른 곳에서 먼저 수정됐습니다.')).toBeVisible()
      await expect(page.getByText('B가 먼저 저장한 본문입니다.')).toBeVisible()
      // Still on the editor, with their own draft intact rather than discarded.
      await expect(page).toHaveURL(new RegExp(`/board/${postId}/edit$`))
      await expect(page.getByLabel('내용')).toHaveValue('A가 나중에 저장한 본문입니다.')

      // And the row still holds B's text. This is the assertion 0033 failed.
      const afterRefusal = await directRequest(page, {
        path: `/rest/v1/board_posts?id=eq.${postId}&select=title,body`,
      })
      expect(JSON.parse(afterRefusal.body)).toEqual([
        { title: `${title} B`, body: 'B가 먼저 저장한 본문입니다.' },
      ])

      // Having been shown B's version, saving again is a decision, and it works:
      // the form advanced to the version it was just shown.
      await page.getByRole('button', { name: '수정하기' }).click()
      await page.waitForURL(`**/board/${postId}`, { timeout: 20_000 })
      const afterDecision = await directRequest(page, {
        path: `/rest/v1/board_posts?id=eq.${postId}&select=title,body`,
      })
      expect(JSON.parse(afterDecision.body)).toEqual([
        { title: `${title} A`, body: 'A가 나중에 저장한 본문입니다.' },
      ])

      expect(withoutHttpErrors(consoleWatcher.errors), 'A 콘솔').toEqual([])
      expect(withoutHttpErrors(tabB.console.errors), 'B 콘솔').toEqual([])
    } finally {
      if (postId) await removePost(page, postId)
      await tabB.close()
    }
  })

  /**
   * The same refusal at the wire, where its shape is visible.
   *
   * The screen keys off the SQLSTATE rather than the HTTP status, so the
   * SQLSTATE is what this pins — along with the DETAIL, because that is where
   * the current text the member is shown actually comes from.
   */
  test('오래된 판본으로 보낸 수정은 PT409로 거절되고 현재 내용을 돌려준다', async ({ page }) => {
    const title = `${PREFIX} 판본 ${Date.now()}`
    let postId = ''

    try {
      postId = await writePost(page, title)
      const v0 = await versionOf(page, postId)

      // One accepted save moves the version on.
      const first = await directRequest(page, {
        path: '/rest/v1/rpc/update_board_post_v1',
        method: 'POST',
        body: {
          p_post_id: postId,
          p_title: `${title} 첫 수정`,
          p_body: '첫 수정 본문',
          p_expected_updated_at: v0,
        },
      })
      expect(first.status).toBe(200)
      const v1 = (JSON.parse(first.body) as { updated_at: string }).updated_at
      expect(v1).not.toBe(v0)

      // The stale one is refused.
      const stale = await directRequest(page, {
        path: '/rest/v1/rpc/update_board_post_v1',
        method: 'POST',
        body: {
          p_post_id: postId,
          p_title: '덮어쓰려던 제목',
          p_body: '덮어쓰려던 본문',
          p_expected_updated_at: v0,
        },
      })
      const refusal = JSON.parse(stale.body) as { code: string; message: string; details: string }
      expect(refusal.code).toBe('PT409')
      expect(refusal.message).toBe('post changed elsewhere')
      // The row it refused in favour of, which is what the screen renders.
      expect(JSON.parse(refusal.details)).toEqual({
        title: `${title} 첫 수정`,
        body: '첫 수정 본문',
        updated_at: v1,
      })

      // A conflict and a missing post are different answers, because they ask
      // opposite things of the person editing.
      const missing = await directRequest(page, {
        path: '/rest/v1/rpc/update_board_post_v1',
        method: 'POST',
        body: {
          p_post_id: '00000000-0000-4000-8000-000000000000',
          p_title: '제목',
          p_body: '본문',
          p_expected_updated_at: v1,
        },
      })
      expect((JSON.parse(missing.body) as { code: string }).code).toBe('42704')
      expect(refusal.code).not.toBe((JSON.parse(missing.body) as { code: string }).code)

      // And the check cannot be skipped by leaving the field out: the
      // three-argument overload is gone, so there is no unchecked way in.
      const omitted = await directRequest(page, {
        path: '/rest/v1/rpc/update_board_post_v1',
        method: 'POST',
        body: { p_post_id: postId, p_title: '제목', p_body: '본문' },
      })
      expect(omitted.status).toBeGreaterThanOrEqual(400)
      expect(omitted.status).toBeLessThan(500)

      // Nothing above changed the row.
      const stored = await directRequest(page, {
        path: `/rest/v1/board_posts?id=eq.${postId}&select=title`,
      })
      expect(JSON.parse(stored.body)).toEqual([{ title: `${title} 첫 수정` }])
    } finally {
      if (postId) await removePost(page, postId)
    }
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
      // The version is the CURRENT one, deliberately. A stale version would make
      // this a conflict test, and the answer would be PT409 — which would leave
      // the authorship refusal unproven while looking like a passing refusal.
      // 0037 checks authorship before staleness precisely so this stays sharp.
      const rpcUpdate = await directRequest(other.page, {
        path: '/rest/v1/rpc/update_board_post_v1',
        method: 'POST',
        body: {
          p_post_id: postId,
          p_title: '가로챈 제목',
          p_body: '가로챈 본문',
          p_expected_updated_at: await versionOf(page, postId),
        },
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

test.describe('자유게시판 — 승인되지 않은 사람', () => {
  test.use({ storageState: STATE.member })

  /**
   * The approval gate and the grants, pinned in every state that has to fail.
   *
   * Neither property is in doubt today. Both have been LOST here before: a
   * `revoke ... from public` once left anon holding EXECUTE, and the approval
   * check had to be restored in 0010 after it went missing. Each was found by
   * querying the live database after the fact, which is a thing somebody has to
   * remember to do. This is the version that runs itself.
   *
   * pending / rejected / blocked are not variants of one another to
   * current_member_id() — it asks for `status = 'approved'` and gets null for
   * all three — but they are three different rows a human would have to reason
   * about, and the cost of naming all three is one array entry each.
   */
  const REFUSED = [
    { label: '승인 대기', state: STATE.pending },
    { label: '거절됨', state: STATE.rejected },
    { label: '내보내짐', state: STATE.blocked },
  ] as const

  for (const { label, state } of REFUSED) {
    test(`${label} 회원은 글을 쓰지도 고치지도 지우지도 못한다`, async ({ page }) => {
      const title = `${PREFIX} 승인거부 ${label} ${Date.now()}`
      let postId = ''
      const outsider = await openAs(browserOf(page), state)

      try {
        // A real post, owned by an approved member, so each refusal below is
        // about the caller's standing rather than about a row that is not there.
        postId = await writePost(page, title)
        const version = await versionOf(page, postId)

        // The outsider's browser has to LOAD the app before anything can be
        // asked of it: directRequest reads the session out of localStorage, and
        // a context that has never navigated is sitting on about:blank, where
        // reading localStorage throws SecurityError rather than returning null.
        // Landing on /pending is also the screen half of this test — RequireAuth
        // turns all three states away from every board route.
        await outsider.page.goto(`/board/${postId}`)
        await outsider.page.waitForURL('**/pending', { timeout: 20_000 })

        const create = await directRequest(outsider.page, {
          path: '/rest/v1/rpc/create_board_post_v1',
          method: 'POST',
          body: { p_title: '들어가면 안 되는 글', p_body: '본문' },
        })
        expect(create.status, `${label} create`).toBe(403)
        expect(create.body).toContain('not an approved member')

        const update = await directRequest(outsider.page, {
          path: '/rest/v1/rpc/update_board_post_v1',
          method: 'POST',
          body: {
            p_post_id: postId,
            p_title: '가로챈 제목',
            p_body: '가로챈 본문',
            p_expected_updated_at: version,
          },
        })
        expect(update.status, `${label} update`).toBe(403)
        expect(update.body).toContain('not an approved member')

        const remove = await directRequest(outsider.page, {
          path: '/rest/v1/rpc/delete_board_post_v1',
          method: 'POST',
          body: { p_post_id: postId },
        })
        expect(remove.status, `${label} delete`).toBe(403)
        expect(remove.body).toContain('not an approved member')

        // Reading is refused too: board_posts_read wants a member id as well.
        const read = await directRequest(outsider.page, {
          path: '/rest/v1/board_posts?select=id',
        })
        expect(JSON.parse(read.body), `${label} read`).toEqual([])

        // The post is exactly as the author left it.
        const stored = await directRequest(page, {
          path: `/rest/v1/board_posts?id=eq.${postId}&select=title`,
        })
        expect(JSON.parse(stored.body)).toEqual([{ title }])
      } finally {
        if (postId) await removePost(page, postId)
        await outsider.close()
      }
    })
  }

  test('세션 없이 publishable key만으로는 어떤 RPC도 부를 수 없다', async ({ page }) => {
    const title = `${PREFIX} anon ${Date.now()}`
    let postId = ''

    try {
      postId = await writePost(page, title)
      const version = await versionOf(page, postId)

      // Every write RPC, with the key a stranger reads out of the bundle.
      for (const [what, body] of [
        ['create', { p_title: '익명이 쓴 글', p_body: '본문' }],
        [
          'update',
          {
            p_post_id: postId,
            p_title: '제목',
            p_body: '본문',
            p_expected_updated_at: version,
          },
        ],
        ['delete', { p_post_id: postId }],
      ] as const) {
        const name = `${what}_board_post_v1`
        const response = await anonRequest(page, {
          path: `/rest/v1/rpc/${name}`,
          method: 'POST',
          body,
        })
        // THE REASON IS THE ASSERTION, not the status, and this test was wrong
        // once for exactly that. It first checked only for "some 4xx", and
        // passed with `grant execute ... to anon` deliberately in place —
        // because the approval gate inside the function answered 403 before the
        // missing grant could matter. A test that cannot tell those apart
        // cannot notice the grant coming back, which is the whole thing it was
        // written to watch.
        //
        //   ungranted           401  permission denied for function <name>
        //   granted, unapproved 403  not an approved member
        expect(response.status, `anon ${what}`).toBe(401)
        expect(response.body, `anon ${what}`).toContain(`permission denied for function ${name}`)
        // The line that fails if EXECUTE is ever handed back to anon.
        expect(response.body, `anon ${what} reached the function body`).not.toContain(
          'not an approved member',
        )
      }

      // board_post_text is granted to nobody at all — not anon, not
      // authenticated. It is only ever called from inside the SECURITY DEFINER
      // functions, which run as its owner and need no grant.
      // The status differs by who is asking — PostgREST answers 401 for the
      // anonymous role and 403 for a role that is authenticated and simply not
      // allowed — so the message is what both are pinned on. Both statuses are
      // named rather than loosened to "4xx", because "some 4xx" is exactly what
      // let the block above pass while anon held EXECUTE.
      for (const [who, send, status] of [
        ['anon', anonRequest, 401],
        ['authenticated', directRequest, 403],
      ] as const) {
        const helper = await send(page, {
          path: '/rest/v1/rpc/board_post_text',
          method: 'POST',
          body: { p_value: '아무거나', p_field: 'title', p_max: 120 },
        })
        expect(helper.status, `${who} board_post_text`).toBe(status)
        expect(helper.body, `${who} board_post_text`).toContain(
          'permission denied for function board_post_text',
        )
      }

      // Reading the table without a session, too. anon holds no SELECT on
      // board_posts at all, so this is refused before RLS is consulted — an
      // empty array would mean the grant exists and only the policy said no.
      const read = await anonRequest(page, { path: '/rest/v1/board_posts?select=id' })
      expect(read.status).toBe(401)
      expect(read.body).toContain('permission denied for table board_posts')

      // Nothing anon sent changed anything.
      const stored = await directRequest(page, {
        path: `/rest/v1/board_posts?id=eq.${postId}&select=title`,
      })
      expect(JSON.parse(stored.body)).toEqual([{ title }])
    } finally {
      if (postId) await removePost(page, postId)
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
        body: {
          p_post_id: postId,
          p_title: '운영진이 고친 제목',
          p_body: '운영진 본문',
          // Current, not stale: the claim being tested is that staff may not
          // edit at all, which has to hold even when they are perfectly in sync.
          p_expected_updated_at: await versionOf(page, postId),
        },
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
