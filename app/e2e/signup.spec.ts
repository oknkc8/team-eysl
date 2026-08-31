import { BASE_URL, FIXTURE_NICK_PREFIX } from '../playwright.config'
import type { Page } from '@playwright/test'
import { APP_ENV, PASSWORD, STATE, directRequest, expect, openAs, test, waitForScreen } from './fixtures'
import { recordOwnedSignup } from './ownedSignups'

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
 * A nickname no other run is using, in the format 0032 requires.
 *
 * The suite is fullyParallel and reruns against a shared dev database, so a
 * fixed nickname would collide with its own previous run and the failure would
 * read as a product bug. The worktree namespace makes concurrent runs distinct;
 * cleanup records the ids returned by these real signups rather than matching
 * either this nickname or its derived email address.
 *
 * SINCE 0032 THE SHAPE IS PART OF THE CONTRACT: 이름/출생년도/성별/지역. Only the
 * name segment carries the unique part, because that is the segment the format
 * leaves free — the other three are constrained, and putting the entropy in the
 * region would work equally well but would move the visible fixture marker out
 * of the name segment.
 */
function freshNickname(tag: string) {
  // The full nickname has an eight-character /98/남/관악 suffix and the server
  // caps it at 30 characters. Five base36 digits leave room for the namespace
  // and every current tag while keeping 60 million concurrent choices.
  const unique = `${FIXTURE_NICK_PREFIX}${tag}${Math.floor(Math.random() * 36 ** 5)
    .toString(36)
    .padStart(5, '0')}`
  return `${unique.toLowerCase()}/98/남/관악`
}

/**
 * What seed.sql gives pwtestmember, restated because the guard reads it.
 *
 * These four values have to agree with `pwtest_accounts` in seed.sql — the
 * fixture there is `(`${FIXTURE_NICK_PREFIX}member`, …, 1970, '남')` — and there is no way to
 * ask the database for them from inside a browser, since `anon` holds no SELECT
 * on members and that is the whole reason the guard lives server-side. So they
 * are duplicated deliberately and named in one place rather than inlined into
 * four assertions.
 */
const SEEDED = {
  nickname: `${FIXTURE_NICK_PREFIX}member`,
  birthYY: '70',
  gender: '남',
  /** Any year but the seeded one: a namesake, and therefore a different person. */
  otherBirthYY: '71',
} as const

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
 * Keep an exact, local record of a signup test's own rows. A fresh browser
 * proves the real login works without changing the anonymous page that drove
 * signup; cleanup receives only these ids and never infers ownership from text.
 */
async function recordSignup(page: Page, nickname: string, password = PASSWORD) {
  const browser = page.context().browser()
  if (!browser) throw new Error('signup ownership: browser is unavailable')

  const context = await browser.newContext({ baseURL: BASE_URL, locale: 'ko-KR', timezoneId: 'Asia/Seoul' })
  const probe = await context.newPage()
  try {
    await signInAs(probe, nickname, password)
    await probe.waitForURL('**/pending', { timeout: 20_000 })
    const authUserId = await probe.evaluate(() => {
      const storageKey = Object.keys(localStorage).find(
        (key) => key.startsWith('sb-') && key.endsWith('-auth-token'),
      )
      if (!storageKey) throw new Error('signup ownership: no Supabase session')
      const raw = localStorage.getItem(storageKey)
      const id = raw ? (JSON.parse(raw) as { user?: { id?: unknown } }).user?.id : undefined
      if (typeof id !== 'string') throw new Error('signup ownership: session has no user id')
      return id
    })
    const member = await directRequest(probe, {
      path: `/rest/v1/members?auth_user_id=eq.${authUserId}&select=id`,
    })
    const rows = JSON.parse(member.body) as { id?: unknown }[]
    if (rows.length !== 1 || typeof rows[0]?.id !== 'string') {
      throw new Error(`signup ownership: expected one member row for ${authUserId}`)
    }
    recordOwnedSignup({ authUserId, memberId: rows[0].id })
  } finally {
    await context.close()
  }
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
  await recordSignup(page, nickname)

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
  await recordSignup(page, nickname)

  // The same nickname again. A unique index arbitrates, not a check-then-insert
  // that a second signup could slip between.
  await submitSignup(page, nickname)
  await expect(page.getByRole('alert')).toHaveText(
    '이미 등록된 회원 정보입니다. 새로 가입하지 마시고 관리자에게 문의해주세요.',
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
  await recordSignup(page, nickname)

  // members_nickname_lower_uq is case-insensitive and the derived address is
  // lowercased, so these must not be allowed to become two people.
  await submitSignup(page, nickname.toUpperCase())
  await expect(page.getByRole('alert')).toHaveText(
    '이미 등록된 회원 정보입니다. 새로 가입하지 마시고 관리자에게 문의해주세요.',
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
  await recordSignup(page, nickname)

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
  await recordSignup(page, nickname)

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

test('닉네임 형식을 화면과 서버 양쪽에서 강제한다', async ({ page }) => {
  // The screen, which is the half that gets to explain itself. Each of these is
  // a different wrong part, and each has to name that part rather than saying
  // the nickname is invalid — somebody who typed their birth year in full has
  // no way to guess which of four segments the form dislikes.
  const onScreen: [string, string][] = [
    ['창호/1998/남/관악', '출생년도는 뒤 두 자리만 입력해주세요. 1998년생이면 98입니다.'],
    ['창호/98/M/관악', '성별은 남 또는 여로 입력해주세요. 예: 창호/98/남/관악'],
    ['창호/98/남', '닉네임은 이름/출생년도/성별/지역 형식으로 입력해주세요. 예: 창호/98/남/관악'],
    ['창호 / 98 / 남 / 관악', '닉네임에는 공백이나 보이지 않는 문자를 넣을 수 없습니다. 예: 창호/98/남/관악'],
    ['창호/98/남/', '지역을 입력해주세요. 예: 창호/98/남/관악'],
    ['창/호/98/남/관악', '이름과 지역에는 /를 넣을 수 없습니다. 예: 창호/98/남/관악'],
  ]

  for (const [nickname, message] of onScreen) {
    await submitSignup(page, nickname)
    await expect(page.getByRole('alert'), nickname).toHaveText(message)
    // Refused without pretending otherwise — still on the form, not on the
    // completion panel.
    await expect(page.getByRole('button', { name: '가입 신청' })).toBeVisible()
  }

  // And the server, asked directly. THIS IS THE HALF THAT MATTERS: a rule that
  // lives only in the form is not a rule, and this project has found that defect
  // often enough to stop taking the form's word for anything. Every call here is
  // anonymous and never loads the screen, so nothing above is running.
  for (const [nickname] of onScreen) {
    const direct = await anonRpc(page, { p_nickname: nickname, p_password: PASSWORD })
    expect(direct.status, nickname).toBe(200)
    const body = JSON.parse(direct.body) as { ok: boolean; message: string }
    expect(body.ok, `${nickname} must be refused by the database`).toBe(false)
    // The sentence is the server's own, and it is the same one the screen showed.
    expect(body.message, nickname).toBe(onScreen.find(([n]) => n === nickname)![1])
  }

  // A short given name — what every one of the club's imported members is
  // called — is refused at signup too. Those rows keep working everywhere else;
  // what 0032 governs is who may newly join.
  const plain = await anonRpc(page, { p_nickname: '철수', p_password: PASSWORD })
  expect(JSON.parse(plain.body)).toMatchObject({ ok: false, reason: 'nickname_parts' })

  // And the format is usable, not merely enforceable.
  const nickname = freshNickname('fmt')
  const good = await anonRpc(page, { p_nickname: nickname, p_password: PASSWORD })
  expect(JSON.parse(good.body)).toEqual({ ok: true })
  await recordSignup(page, nickname)
})

test('명단에 이미 있는 회원은 새 계정을 만들지 못한다', async ({ page }) => {
  test.slow()
  await page.goto('/signup')

  // THE GHOST ROW. Before 0032's guard this was the format rule's worst side
  // effect: 36 of the 41 members in the dev database came from the club's
  // spreadsheet and have no login, and they are precisely the people this form
  // is for. A plain nickname collides with members_nickname_lower_uq and is
  // refused loudly. The SAME PERSON typing the SAME NAME in the new format is a
  // different string, so nothing collided — signup succeeded, and their
  // attendance and records stayed on a row nobody was attached to.
  //
  // Driven through the seeded fixture rather than a real member, so this test
  // owns the row it depends on: seed.sql gives pwtestmember short_name,
  // birth_year and gender exactly as the workbook importer does, and leaves
  // `location` null exactly as the importer does.
  //
  // The guard matches 이름 + 출생년도 + 성별 and deliberately IGNORES 지역, so two
  // different regions have to give the same answer. If 지역 counted, a returning
  // member who moved house would sail straight past it into a ghost row.
  for (const region of ['관악', '서초']) {
    const attempt = await anonRpc(page, {
      p_nickname: `${SEEDED.nickname}/${SEEDED.birthYY}/${SEEDED.gender}/${region}`,
      p_password: PASSWORD,
    })
    expect(attempt.status).toBe(200)
    expect(JSON.parse(attempt.body), region).toMatchObject({
      ok: false,
      reason: 'already_registered',
    })
  }

  // Refused, and nothing created: the whole point is that no second row appears.
  // Asked the only way an anonymous caller can ask — `anon` holds no SELECT on
  // members — by claiming the same nickname again and seeing the same refusal.
  //
  // The reason is `already_registered` for BOTH the roster match and a real
  // unique violation, on purpose: telling an anonymous caller which one fired
  // would distinguish "on the club roster" from "this nickname is registered",
  // and that distinction is the membership oracle 0032 moved the guard to close.
  const again = await anonRpc(page, {
    p_nickname: `${SEEDED.nickname}/${SEEDED.birthYY}/${SEEDED.gender}/관악`,
    p_password: PASSWORD,
  })
  expect(JSON.parse(again.body)).toMatchObject({ reason: 'already_registered' })

  // And it must not defeat the format's whole purpose. A DIFFERENT person with
  // the same given name, born in another year, is a different member and still
  // gets in — otherwise the club could never admit a second 영희, which is the
  // very thing the format was introduced to make possible.
  const namesake = await anonRpc(page, {
    p_nickname: `${SEEDED.nickname}/${SEEDED.otherBirthYY}/${SEEDED.gender}/관악`,
    p_password: PASSWORD,
  })
  expect(JSON.parse(namesake.body)).toEqual({ ok: true })
  await recordSignup(page, `${SEEDED.nickname}/${SEEDED.otherBirthYY}/${SEEDED.gender}/관악`)
})

test('가입 대기 회원은 회원 정보를 하나도 읽지 못한다', async ({ page }) => {
  test.slow()
  const nickname = freshNickname('gate')

  await submitSignup(page, nickname)
  await expect(page.getByRole('heading', { name: `${nickname} 가입 신청 완료` })).toBeVisible({
    timeout: 20_000,
  })
  await recordSignup(page, nickname)
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
