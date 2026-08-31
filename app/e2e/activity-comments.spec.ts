import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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
 * What push_notify_context_v1('activity_comment_created', commentId) actually
 * returns — the one thing no client request can ask, because the function is
 * granted to service_role alone (0022/0023). Shelled to psql the same way
 * global-setup.ts reaches the database for its own privileged checks: there is
 * no REST path for this that a member's session, or even the anon key, can
 * take.
 */
function pushContextFor(commentId: string): { member_count: number; recipients: { endpoint: string }[] } {
  const sql = `select public.push_notify_context_v1('activity_comment_created', '${commentId}')`
  const out = execFileSync('bash', ['scripts/psql.sh', '-tAX', '-c', sql], {
    cwd: appDir,
    encoding: 'utf8',
  }).trim()
  const context = JSON.parse(out) as { fact: unknown; member_count: number; recipients: { endpoint: string }[] }
  return context
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
      // The author's own name, read through member_public_v — exact, and
      // scoped to this specific comment's <li>, not `{ exact: false }`
      // anywhere on the page, which pwtestmember2 (this fixture activity's
      // waitlister, seed.sql) would also satisfy. A row fresh from
      // append_activity_comment carries no nickname at all, so this only
      // appears if the refetch and its embed both worked.
      const posted = page.locator('.comment', { has: page.locator('.body', { hasText: body }) })
      await expect(posted.locator('.commentHead b')).toHaveText('pwtestmember')

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

  test('승인 회원이면 이 활동 참여 여부와 무관하게 댓글을 읽을 수 있다', async ({ page }) => {
    // activity_comments_read is `current_member_id() is not null` — any
    // approved member, participant or not. Proven by content, not by an
    // absence of error: RLS hiding every row and a genuinely empty thread
    // render the identical "아직 댓글이 없습니다" screen, so a real comment has
    // to exist and actually appear for this to mean anything.
    const other = await openAs(page.context().browser()!, STATE.member2)
    let commentId = ''
    // Navigated first: directRequest reads the session out of localStorage,
    // which throws SecurityError on a fresh context still on about:blank.
    await page.goto('/')
    try {
      const body = `${PREFIX} 읽기확인 ${Date.now()}`
      const created = await insertComment(page, body)
      expect(created.status).toBe(200)
      commentId = (JSON.parse(created.body) as { id: string }).id

      await other.page.goto(`/schedule/${SEED.commentActivityId}`)
      await waitForScreen(other.page)
      await expect(
        other.page.getByRole('heading', { name: SEED.commentActivityTitle }),
      ).toBeVisible()
      await expect(other.page.locator('.comment .body', { hasText: body })).toBeVisible()
    } finally {
      if (commentId) await removeComment(page, commentId)
      await other.close()
    }
  })
})

test.describe('일정 댓글 — 푸시 대상', () => {
  test.use({ storageState: STATE.member })

  /**
   * The one thing every other test in this file cannot reach: whether
   * push_notify_context_v1's activity_comment_created branch actually computes
   * the audience the design promises — that activity's own applicants AND
   * waitlisters, excluding the commenter, and nobody outside that set even if
   * they hold a device and even if they are staff.
   *
   * The fixture (seed.sql) gives three members a push_subscriptions row:
   * pwtestmember (the commenter here — must be excluded despite having a
   * device), pwtestmember2 (waitlisted on this same activity — must be
   * included, which is the participant-only regression this guards), and
   * pwtestadmin (staff, but never applied to this activity — must be excluded,
   * which is the "not the whole club" regression this guards).
   */
  test('참가자·대기자만 대상이고, 작성자와 무관한 운영진은 빠진다', async ({ page }) => {
    let commentId = ''
    // Navigated first: directRequest reads the session out of localStorage,
    // which throws SecurityError on a fresh context still on about:blank.
    await page.goto('/')
    try {
      const created = await insertComment(page, `${PREFIX} 푸시대상 ${Date.now()}`)
      expect(created.status).toBe(200)
      commentId = (JSON.parse(created.body) as { id: string }).id

      const context = pushContextFor(commentId)
      expect(context.member_count).toBe(1)
      expect(context.recipients).toHaveLength(1)
      expect(context.recipients[0]!.endpoint).toBe(
        'https://fcm.googleapis.com/fcm/send/pwtest-pwtestmember2',
      )
    } finally {
      if (commentId) await removeComment(page, commentId)
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
