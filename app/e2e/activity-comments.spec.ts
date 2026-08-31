import {
  APP_ENV,
  MISSING_UUID,
  SEED,
  STATE,
  directRequest,
  expect,
  openAs,
  test,
  waitForScreen,
} from './fixtures'
import type { Page } from '@playwright/test'

/**
 * 일정(훈련/대회/기타) 댓글 (0050), driven the way a member drives it.
 *
 * Same three reasons a test exists here that board.spec.ts and notices'
 * suite already document, applied to this feature:
 *
 *  - **The author's nickname on the thread.** listActivityComments asks
 *    PostgREST to embed member_public_v through activity_comments.member_id,
 *    the same shape notices/api.ts's listComments uses. That the generated
 *    types accept it says the schema cache knows the relationship, not that a
 *    request returns a name.
 *  - **The refusals are the database's, not the screen's.** There is no
 *    "본인 또는 운영진만" copy in this screen at all — no delete button is
 *    offered to anyone (see ActivityDetailPage.tsx's Comments component) — so
 *    the only way to know the DELETE policy actually holds is to send the
 *    request the screen never offers, from each caller's own session.
 *  - **The author is server-derived, and there is nothing here to prove that
 *    except calling the RPC and reading who it says wrote the row back.**
 *    append_activity_comment takes no member id parameter at all — there is
 *    no field to spoof — so the only assertion possible is that the row it
 *    returns names the caller.
 */

const PREFIX = 'pwtest 댓글 훈련'

/** Direct REST is used throughout rather than the UI: the point of most of
 * these tests is a request the screen never sends. */
async function insertComment(page: Page, body: string) {
  return directRequest(page, {
    path: '/rest/v1/rpc/append_activity_comment',
    method: 'POST',
    body: { p_activity_id: SEED.commentActivityId, p_body: body },
  })
}

/** Remove a comment as staff — cleanup for a test whose row would otherwise
 * accumulate on the shared fixture activity across runs. */
async function removeComment(admin: Page, commentId: string) {
  await directRequest(admin, {
    path: `/rest/v1/activity_comments?id=eq.${commentId}`,
    method: 'DELETE',
  })
}

/**
 * A request carrying the publishable key and NO session — what a stranger
 * with the bundle in their browser can send. Copied from board.spec.ts:
 * directRequest reads the page's own token, which is exactly what this must
 * NOT do.
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

test.describe('일정 댓글 — 작성과 목록', () => {
  test.use({ storageState: STATE.member })

  test('회원이 쓴 댓글이 닉네임과 함께 목록에 남는다', async ({ page, consoleWatcher }) => {
    const body = `${PREFIX} 작성 ${Date.now()}`
    let commentId = ''
    const admin = await openAs(page.context().browser()!, STATE.admin)
    // Navigated even though this session never asserts on a screen: directRequest
    // reads the session out of localStorage, which throws SecurityError on a
    // context still sitting on about:blank.
    await admin.page.goto('/')

    try {
      await page.goto(`/schedule/${SEED.commentActivityId}`)
      await waitForScreen(page)
      await expect(page.getByRole('heading', { name: SEED.commentActivityTitle })).toBeVisible()

      await page.getByLabel('댓글 입력').fill(body)
      await page.getByRole('button', { name: '등록' }).click()

      // The row is read back from the server rather than trusted from the
      // form: appendActivityComment returns nothing on purpose, so anything
      // on screen after the click came from the refetch.
      await expect(page.getByText(body)).toBeVisible()
      await expect(page.getByLabel('댓글 입력')).toHaveValue('')

      await page.reload()
      await waitForScreen(page)
      await expect(page.getByText(body)).toBeVisible()
      // The author's own name, read through member_public_v. A row fresh
      // from append_activity_comment carries no nickname at all, so this
      // only appears if the refetch and its embed both worked.
      await expect(page.getByText('pwtestmember', { exact: false }).first()).toBeVisible()

      const stored = await directRequest(page, {
        path: `/rest/v1/activity_comments?activity_id=eq.${SEED.commentActivityId}&body=eq.${encodeURIComponent(body)}&select=id,member_id`,
      })
      const rows = JSON.parse(stored.body) as { id: string; member_id: string }[]
      expect(rows).toHaveLength(1)
      commentId = rows[0]!.id
      // Server-derived, not client-supplied — the RPC has no parameter a
      // caller could have used to name anyone else.
      expect(rows[0]!.member_id).toBe(SEED.memberMemberId)

      expect(consoleWatcher.errors).toEqual([])
    } finally {
      if (commentId) await removeComment(admin.page, commentId)
      await admin.close()
    }
  })

  test('활동에 참여하지 않은 승인 회원도 댓글 목록을 읽을 수 있다', async ({ page }) => {
    // activity_comments_read is `current_member_id() is not null` — any
    // approved member, not just this activity's applicants. member2 never
    // applies to the fixture activity, which is exactly what makes this
    // read a test of the read policy rather than of participation.
    const other = await openAs(page.context().browser()!, STATE.member2)
    try {
      await other.page.goto(`/schedule/${SEED.commentActivityId}`)
      await waitForScreen(other.page)
      await expect(
        other.page.getByRole('heading', { name: SEED.commentActivityTitle }),
      ).toBeVisible()
      // No prior comment needed for this assertion — an empty or populated
      // thread both prove the read succeeded, so this only checks the screen
      // did not fall into the error state.
      await expect(other.page.getByText('댓글을 불러오지 못했습니다')).toHaveCount(0)
    } finally {
      await other.close()
    }
  })
})

test.describe('일정 댓글 — 직접 요청', () => {
  test.use({ storageState: STATE.member })

  test('테이블에 직접 쓸 수 없다 — INSERT 정책이 없다', async ({ page }) => {
    // Navigated first: directRequest reads the session out of localStorage,
    // which throws SecurityError on a fresh context still on about:blank.
    await page.goto('/')
    // activity_comments has no INSERT policy at all (0050) — every write goes
    // through append_activity_comment. What matters is not the status of the
    // attempt but whether a row landed, the same distinguishing check
    // board.spec.ts's anon block makes for a missing grant vs. a policy that
    // matches nothing.
    const marker = `${PREFIX} 직접삽입 ${Date.now()}`
    await directRequest(page, {
      path: '/rest/v1/activity_comments',
      method: 'POST',
      body: { activity_id: SEED.commentActivityId, member_id: SEED.memberMemberId, body: marker },
    })
    const stored = await directRequest(page, {
      path: `/rest/v1/activity_comments?activity_id=eq.${SEED.commentActivityId}&body=eq.${encodeURIComponent(marker)}&select=id`,
    })
    expect(JSON.parse(stored.body)).toEqual([])
  })

  test('빈 댓글과 없는 일정은 RPC 안에서 거절된다', async ({ page }) => {
    // Navigated first: directRequest reads the session out of localStorage,
    // which throws SecurityError on a fresh context still on about:blank.
    await page.goto('/')
    const empty = await insertComment(page, '   ')
    expect(empty.status).toBe(400)
    expect(empty.body).toContain('comment body is empty')

    const missingActivity = await directRequest(page, {
      path: '/rest/v1/rpc/append_activity_comment',
      method: 'POST',
      body: { p_activity_id: MISSING_UUID, p_body: '아무 말' },
    })
    expect(missingActivity.status).toBe(409)
    expect(missingActivity.body).toContain('no such activity')
  })

  test('세션 없이 publishable key만으로는 RPC를 부를 수 없다', async ({ page }) => {
    // anonRequest itself needs no session, but the verification directRequest
    // below does — reading it out of localStorage throws SecurityError on a
    // fresh context still on about:blank.
    await page.goto('/')
    const response = await anonRequest(page, {
      path: '/rest/v1/rpc/append_activity_comment',
      method: 'POST',
      body: { p_activity_id: SEED.commentActivityId, p_body: '익명이 쓴 댓글' },
    })
    // ungranted (401), not merely unapproved (403) — the same discriminator
    // board.spec.ts's anon block exists to keep sharp: EXECUTE was never
    // handed to anon in 0050, and "some 4xx" would pass just as well with it
    // handed back by mistake.
    expect(response.status).toBe(401)
    expect(response.body).toContain('permission denied for function append_activity_comment')
    expect(response.body).not.toContain('not an approved member')

    const stored = await directRequest(page, {
      path: `/rest/v1/activity_comments?activity_id=eq.${SEED.commentActivityId}&body=eq.${encodeURIComponent('익명이 쓴 댓글')}&select=id`,
    })
    expect(JSON.parse(stored.body)).toEqual([])
  })
})

test.describe('일정 댓글 — 지우기 (화면에 없는 통제)', () => {
  test.use({ storageState: STATE.member })

  test('본인은 지울 수 있고, 남은 못 지운다', async ({ page }) => {
    const other = await openAs(page.context().browser()!, STATE.member2)
    let commentId = ''
    // Both navigated: directRequest reads the session out of localStorage,
    // which throws SecurityError on a fresh context still on about:blank.
    await page.goto('/')
    await other.page.goto('/')

    try {
      const created = await insertComment(page, `${PREFIX} 삭제 ${Date.now()}`)
      expect(created.status).toBe(200)
      commentId = (JSON.parse(created.body) as { id: string }).id

      // Someone else's session, matched by RLS rather than refused outright —
      // an empty array, the same "matched nothing" shape board.spec.ts pins
      // for a stranger's PATCH on another member's post.
      const strangerDelete = await directRequest(other.page, {
        path: `/rest/v1/activity_comments?id=eq.${commentId}`,
        method: 'DELETE',
      })
      expect(JSON.parse(strangerDelete.body)).toEqual([])

      const stillThere = await directRequest(page, {
        path: `/rest/v1/activity_comments?id=eq.${commentId}&select=id`,
      })
      expect(JSON.parse(stillThere.body)).toHaveLength(1)

      // The author's own session succeeds.
      const ownDelete = await directRequest(page, {
        path: `/rest/v1/activity_comments?id=eq.${commentId}`,
        method: 'DELETE',
      })
      expect(JSON.parse(ownDelete.body)).toHaveLength(1)
      commentId = ''
    } finally {
      if (commentId) await removeComment(page, commentId)
      await other.close()
    }
  })

  test('운영진은 남의 댓글을 지울 수 있다', async ({ page }) => {
    const admin = await openAs(page.context().browser()!, STATE.admin)
    let commentId = ''
    // Both navigated: directRequest reads the session out of localStorage,
    // which throws SecurityError on a fresh context still on about:blank.
    await page.goto('/')
    await admin.page.goto('/')

    try {
      const created = await insertComment(page, `${PREFIX} 운영진삭제 ${Date.now()}`)
      commentId = (JSON.parse(created.body) as { id: string }).id

      const staffDelete = await directRequest(admin.page, {
        path: `/rest/v1/activity_comments?id=eq.${commentId}`,
        method: 'DELETE',
      })
      expect(JSON.parse(staffDelete.body)).toHaveLength(1)
      commentId = ''
    } finally {
      if (commentId) await removeComment(page, commentId)
      await admin.close()
    }
  })
})

test.describe('일정 댓글 — 승인되지 않은 사람', () => {
  test.use({ storageState: STATE.member })

  const REFUSED = [
    { label: '승인 대기', state: STATE.pending },
    { label: '거절됨', state: STATE.rejected },
    { label: '내보내짐', state: STATE.blocked },
  ] as const

  for (const { label, state } of REFUSED) {
    test(`${label} 회원은 댓글을 쓸 수 없다`, async ({ page }) => {
      const outsider = await openAs(page.context().browser()!, state)
      // The post-check below runs directRequest on the main page, which
      // otherwise never navigates in this test — same SecurityError as the
      // rest of this file's directRequest calls on an about:blank context.
      await page.goto('/')
      try {
        await outsider.page.goto(`/schedule/${SEED.commentActivityId}`)
        await outsider.page.waitForURL('**/pending', { timeout: 20_000 })

        const marker = `${PREFIX} 승인거부 ${label}`
        const attempt = await insertComment(outsider.page, marker)
        expect(attempt.status, label).toBe(403)
        expect(attempt.body, label).toContain('not an approved member')

        const stored = await directRequest(page, {
          path: `/rest/v1/activity_comments?activity_id=eq.${SEED.commentActivityId}&body=eq.${encodeURIComponent(marker)}&select=id`,
        })
        expect(JSON.parse(stored.body)).toEqual([])
      } finally {
        await outsider.close()
      }
    })
  }
})
