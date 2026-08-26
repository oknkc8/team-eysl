import type { Page } from '@playwright/test'
import { APP_ENV, PASSWORD, STATE, expect, openAs, test, waitForScreen } from './fixtures'

/**
 * 가입 신청, driven the way the defect was found: by pressing the button.
 *
 * This is the one flow where a failure means nobody new can ever join, and it
 * was broken from the day the screen was built — auth.signUp answers 400
 * email_address_invalid for `<nickname>@eysl.local` because GoTrue validates
 * deliverability, while signInWithPassword accepts the very same address. Login
 * worked, so every existing test stayed green and the club simply could not take
 * a member. flows.spec.ts came closest and still missed it: it asserts the link
 * reaches /signup and the button renders, then stops before pressing it.
 *
 * 0028 moved account creation into register_member_v1(). These tests are what
 * stop it regressing back into a screen that looks fine and does nothing.
 *
 * Everything here is anonymous, so the whole file drops the stored session.
 */
test.use({ storageState: { cookies: [], origins: [] } })

/**
 * The password every account made here is created with — the run password from
 * fixtures, not a literal.
 *
 * These accounts are made by the test through the real 가입 신청 flow, so they
 * are `pending` and reach nothing; but cleanup can fail, and a pending account
 * whose password is printed in a public repository is still an account somebody
 * else can sign into. Per-run means a leftover one is dead on arrival.
 */

/**
 * A nickname no other run is using.
 *
 * The suite is fullyParallel and reruns against a shared dev database, so a
 * fixed nickname would collide with its own previous run and the failure would
 * read as a product bug. The `pwtest` prefix is the contract cleanup.sql matches
 * on, and lowercase keeps the derived address (`lower(nickname)@eysl.local`)
 * equal to the nickname, which is what makes cleanup's `email like
 * 'pwtest%@eysl.local'` match it too.
 */
function freshNickname(tag: string) {
  return `pwtest${tag}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`.toLowerCase()
}

/** Fill in the form and press 가입 신청. */
async function submitSignup(page: Page, nickname: string, password = PASSWORD) {
  await page.goto('/signup')
  await page.getByLabel('닉네임').fill(nickname)
  await page.getByLabel('비밀번호').fill(password)
  await page.getByRole('button', { name: '가입 신청' }).click()
}

/**
 * Sign in through the real form.
 *
 * Local rather than fixtures.signIn() because that helper is hard-wired to the
 * seeded password, and every account here is created by the test with its own.
 */
async function signInAs(page: Page, nickname: string, password = PASSWORD) {
  await page.goto('/login')
  await page.getByLabel('닉네임').fill(nickname)
  await page.getByLabel('비밀번호').fill(password)
  await page.getByRole('button', { name: '로그인' }).click()
}

/**
 * Call the RPC straight from the browser with no session at all.
 *
 * The refusals below have to be asked of the *server*, not of the form. A screen
 * that refuses a seven-character password proves the screen refuses it; whether
 * the database would is a different question, and the only honest way to ask is
 * to send the request the form would never send. Anonymous on purpose — this is
 * exactly the reach an unauthenticated stranger has.
 */
async function anonRpc(page: Page, body: Record<string, unknown>) {
  return page.evaluate(
    async ({ base, key, payload }) => {
      const response = await fetch(`${base}/rest/v1/rpc/register_member_v1`, {
        method: 'POST',
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      return { status: response.status, body: await response.text() }
    },
    { base: APP_ENV.url, key: APP_ENV.key, payload: body },
  )
}

// ---------------------------------------------------------------------------
// The journey: join, wait, be admitted.
// ---------------------------------------------------------------------------

test('가입 신청부터 승인까지 실제로 이어진다', async ({ page, browser, consoleWatcher }) => {
  // Slower than the smoke tests by design: it signs up, signs in, opens a second
  // browser as the 총관리자, approves, and comes back.
  test.slow()

  const nickname = freshNickname('join')

  // 1. 가입 신청 through the screen.
  await submitSignup(page, nickname)
  await expect(page.getByRole('heading', { name: `${nickname} 가입 신청 완료` })).toBeVisible({
    timeout: 20_000,
  })

  // 2. The new account signs in. This is the half that always worked and the
  //    half that made the break invisible, so it is asserted rather than assumed.
  await signInAs(page, nickname)

  // 3. A new member is pending, so RequireAuth holds them at /pending. Landing
  //    anywhere else would mean the row came back approved, which is the whole
  //    escalation this design exists to prevent.
  await page.waitForURL('**/pending', { timeout: 20_000 })
  await expect(page.getByRole('heading', { name: '가입 승인 대기 중' })).toBeVisible()

  // Direct navigation too: /pending must be where they belong, not merely where
  // one redirect happens to point.
  await page.goto('/')
  await page.waitForURL('**/pending', { timeout: 20_000 })

  // 4. The 총관리자 admits them.
  const admin = await openAs(browser, STATE.admin)
  try {
    await admin.page.goto('/members/approval')
    await waitForScreen(admin.page)

    const row = admin.page.getByRole('listitem').filter({ hasText: nickname })
    await expect(row).toHaveCount(1)
    await row.getByRole('button', { name: '승인' }).click()

    // NOT `expect(row).toHaveCount(0)` — that was the first version and it hung
    // for the full timeout against a screen doing exactly the right thing. An
    // approved applicant does not leave the page, it moves from 승인 대기 into
    // 최근 처리한 회원, which is another <li> carrying the same nickname. What
    // has to disappear is the decision, not the person.
    await expect(row.getByRole('button', { name: '승인' })).toHaveCount(0, { timeout: 20_000 })
    // And the screen has to say which way the decision went — the whole reason
    // that section was kept from the legacy app.
    await expect(row).toContainText('승인됨')
    expect(admin.console.errors, 'console on the approval screen').toEqual([])
  } finally {
    await admin.close()
  }

  // 5. Back in the member's browser: the same session now reaches the app.
  //    Reloaded rather than re-logged-in, because the promise the screen makes is
  //    "승인된 뒤 같은 기기에서 앱을 열면 바로 홈으로 들어갑니다".
  await page.goto('/')
  await expect(page.getByRole('heading', { name: `안녕하세요, ${nickname}님` })).toBeVisible({
    timeout: 20_000,
  })

  expect(consoleWatcher.errors, 'console across the whole journey').toEqual([])
})

// ---------------------------------------------------------------------------
// The refusals. Each one has to say something a person can act on.
// ---------------------------------------------------------------------------

test('이미 쓰는 닉네임은 한국어로 거절한다', async ({ page }) => {
  test.slow()
  const nickname = freshNickname('dup')

  await submitSignup(page, nickname)
  await expect(page.getByRole('heading', { name: `${nickname} 가입 신청 완료` })).toBeVisible({
    timeout: 20_000,
  })

  // The same nickname again. A unique index arbitrates, not a check-then-insert
  // that a second signup could slip between.
  await submitSignup(page, nickname)
  await expect(page.getByRole('alert')).toHaveText(
    '이미 사용 중인 닉네임입니다. 다른 닉네임을 입력해주세요.',
    { timeout: 20_000 },
  )

  // Refused, and refused without pretending otherwise: the applicant is still on
  // the form rather than on the completion panel.
  await expect(page.getByRole('button', { name: '가입 신청' })).toBeVisible()
})

test('대소문자만 다른 닉네임도 같은 닉네임으로 본다', async ({ page }) => {
  test.slow()
  const nickname = freshNickname('case')

  await submitSignup(page, nickname)
  await expect(page.getByRole('heading', { name: `${nickname} 가입 신청 완료` })).toBeVisible({
    timeout: 20_000,
  })

  // members_nickname_lower_uq is case-insensitive and the derived address is
  // lowercased, so these must not be allowed to become two people.
  await submitSignup(page, nickname.toUpperCase())
  await expect(page.getByRole('alert')).toHaveText(
    '이미 사용 중인 닉네임입니다. 다른 닉네임을 입력해주세요.',
    { timeout: 20_000 },
  )
})

test('짧은 비밀번호는 화면과 서버 양쪽에서 막힌다', async ({ page }) => {
  // The screen's own refusal.
  await submitSignup(page, freshNickname('pw'), 'swim123')
  await expect(page.getByRole('alert')).toHaveText('비밀번호는 8자 이상으로 설정해주세요.')

  // And the server's, asked directly — the form is not the rule, it is the
  // reminder. A caller who never loads the screen gets the same sentence.
  const nickname = freshNickname('pw')
  const direct = await anonRpc(page, { p_nickname: nickname, p_password: 'swim123' })
  expect(direct.status).toBe(200)
  expect(JSON.parse(direct.body)).toEqual({
    ok: false,
    reason: 'password_short',
    message: '비밀번호는 8자 이상으로 설정해주세요.',
  })

  // A refused call must not have created the account anyway.
  //
  // Asking `members` directly was the first version and it could not answer the
  // question: `anon` holds no SELECT on that table at all, so the read comes back
  // 42501 whether the row exists or not. The absence is asked of the one
  // endpoint an anonymous caller does have — claiming the same nickname a second
  // time. `ok:true` is only possible if nothing took it, so a created account
  // would show up here as nickname_taken.
  const retry = await anonRpc(page, { p_nickname: nickname, p_password: PASSWORD })
  expect(JSON.parse(retry.body)).toEqual({ ok: true })

  // While we are here: `anon` cannot read the roster, which is what made the
  // check above impossible and is worth pinning in its own right.
  const listed = await page.evaluate(
    async ({ base, key }) => {
      const r = await fetch(`${base}/rest/v1/members?select=nickname&limit=1`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      })
      return { status: r.status, body: await r.text() }
    },
    { base: APP_ENV.url, key: APP_ENV.key },
  )
  expect(listed.status).toBe(401)
  expect(listed.body).toContain('42501')
})

test('status·role 을 함께 보내면 함수 자체가 매칭되지 않는다', async ({ page }) => {
  test.slow()
  await page.goto('/signup')

  // The escalation attempt this whole shape exists to refuse. PostgREST resolves
  // an RPC by argument name, so the extra keys are not quietly ignored — the
  // request matches no function at all, and nothing is created.
  const escalate = await anonRpc(page, {
    p_nickname: freshNickname('esc'),
    p_password: PASSWORD,
    status: 'approved',
    role: 'master_admin',
  })
  expect(escalate.status).toBe(404)
  expect(escalate.body).toContain('PGRST202')

  // And the call that *is* allowed cannot carry a status either, because the
  // function has nowhere to put one. Proven by making an account the only way
  // the API permits and then reading back what it actually became.
  const nickname = freshNickname('esc')
  const created = await anonRpc(page, { p_nickname: nickname, p_password: PASSWORD })
  expect(JSON.parse(created.body)).toEqual({ ok: true })

  await signInAs(page, nickname)
  await page.waitForURL('**/pending', { timeout: 20_000 })
  await expect(page.getByRole('heading', { name: '가입 승인 대기 중' })).toBeVisible()
})

test('너무 짧거나 긴 닉네임을 거절한다', async ({ page }) => {
  await submitSignup(page, '수')
  await expect(page.getByRole('alert')).toHaveText('닉네임은 2자 이상 입력해주세요.')

  // The input caps at maxLength, so the screen never sees 31 characters. The
  // server is the one that has to hold that line, and it is asked directly.
  const long = await anonRpc(page, { p_nickname: '가'.repeat(31), p_password: PASSWORD })
  expect(JSON.parse(long.body)).toMatchObject({ ok: false, reason: 'nickname_long' })

  const short = await anonRpc(page, { p_nickname: '수', p_password: PASSWORD })
  expect(JSON.parse(short.body)).toMatchObject({ ok: false, reason: 'nickname_short' })
})

test('가입 대기 회원은 회원 정보를 하나도 읽지 못한다', async ({ page }) => {
  test.slow()
  const nickname = freshNickname('gate')

  await submitSignup(page, nickname)
  await expect(page.getByRole('heading', { name: `${nickname} 가입 신청 완료` })).toBeVisible({
    timeout: 20_000,
  })
  await signInAs(page, nickname)
  await page.waitForURL('**/pending', { timeout: 20_000 })

  // The account is real and the session is valid — that is the point. What it
  // reaches is the question, and current_member_id() answers null until an admin
  // approves, so every table gated on it must come back empty rather than merely
  // being hidden by a screen that does not render a link.
  const reachable = await page.evaluate(
    async ({ base, key }) => {
      const storageKey = Object.keys(localStorage).find(
        (k) => k.startsWith('sb-') && k.endsWith('-auth-token'),
      )
      if (!storageKey) throw new Error('no supabase session in localStorage')
      const raw = localStorage.getItem(storageKey)
      if (!raw) throw new Error('supabase session key present but empty')
      const token = (JSON.parse(raw) as { access_token?: string }).access_token
      if (!token) throw new Error('supabase session has no access_token')

      const out: Record<string, string> = {}
      for (const table of ['member_public_v', 'notices', 'activities', 'records', 'media_folders']) {
        const r = await fetch(`${base}/rest/v1/${table}?select=*&limit=1`, {
          headers: { apikey: key, Authorization: `Bearer ${token}` },
        })
        out[table] = await r.text()
      }
      return out
    },
    { base: APP_ENV.url, key: APP_ENV.key },
  )

  for (const [table, body] of Object.entries(reachable)) {
    expect(body, `${table} as a pending member`).toBe('[]')
  }
})
