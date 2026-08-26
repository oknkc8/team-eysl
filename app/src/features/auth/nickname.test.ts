import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  NICKNAME_FORBIDDEN,
  NICKNAME_FORMAT_EXAMPLE,
  NICKNAME_PATTERN,
  NICKNAME_PATTERN_SOURCE,
  canonicalNickname,
  checkNicknameFormat,
} from './nickname'
import { validateSignup } from './signup'
import { emailForNickname, memberSchema } from './schema'

// Resolved from the Vite root rather than from import.meta.url: the suite runs
// under `environment: 'jsdom'` (vite.config.ts), where import.meta.url is an
// http:// URL and fileURLToPath refuses it with "The URL must be of scheme
// file". process.cwd() is `app/`, which is where vitest is started from.
const MIGRATION = resolve(process.cwd(), 'supabase/migrations/0032_signup_nickname_format.sql')

// Spelled rather than typed — an invisible character pasted into a test file is
// not something a reviewer can check. These are the two lookalike attacks:
// U+FEFF, which Postgres does not count as whitespace, and U+200B, which
// neither engine's character classes catch at all.
const BOM = String.fromCodePoint(0xfeff)
const ZWSP = String.fromCodePoint(0x200b)

// ---------------------------------------------------------------------------
// The duplication. This is the point of the file.
// ---------------------------------------------------------------------------
//
// The rule exists twice — here and in 0032 — because the client is not a
// control and the server has no way to write a good Korean sentence about a form
// field it cannot see. Two copies of a rule drift; these tests are what stops
// the drift being silent.

describe('the pattern the browser and the database share', () => {
  const sql = readFileSync(MIGRATION, 'utf8')

  it('appears in 0032 byte-for-byte', () => {
    expect(sql).toContain(`'${NICKNAME_PATTERN_SOURCE}'`)
  })

  // Belt and braces: 0032 diagnoses part by part *and* checks the whole pattern.
  // Losing the second one would leave six hand-written conditions as the only
  // authority, which is exactly the arrangement that drifts.
  it('is applied in 0032 as a refusal, not merely mentioned in a comment', () => {
    expect(sql).toContain(`if v_nickname !~ '${NICKNAME_PATTERN_SOURCE}' then`)
  })

  // Every reason the client can produce must be a reason the server produces,
  // with the same sentence. A client-only message would be a promise the server
  // does not keep for a direct caller.
  it('answers every refusal with the same reason and sentence the server does', () => {
    const cases = [
      '창호 / 98 / 남 / 관악',
      '창/호/98/남/관악',
      '창호/98/남',
      '/98/남/관악',
      '창호/1998/남/관악',
      '창호/98/M/관악',
      '창호/98/남/',
    ]

    const seen = new Set<string>()
    for (const nickname of cases) {
      const refusal = checkNicknameFormat(nickname)
      expect(refusal, `${nickname} must be refused`).not.toBeNull()
      seen.add(refusal!.reason)

      expect(sql, `0032 must carry reason ${refusal!.reason}`).toContain(
        `'reason', '${refusal!.reason}'`,
      )
      expect(sql, `0032 must carry the sentence for ${refusal!.reason}`).toContain(
        `'message', '${refusal!.message}'`,
      )
    }

    // Guards the loop itself: if a future edit collapsed the branches into one
    // generic message, every assertion above would still pass on a single reason.
    expect(seen.size).toBe(7)
  })

  // The forbidden-character rule is the one thing that could NOT be one shared
  // string: a POSIX class means something else entirely to JavaScript. So the
  // two spellings are pinned instead, and BOTH halves have to be present in the
  // SQL or the sets stop being equal.
  //
  // The second assertion is the one that matters most. Neither [[:space:]] nor
  // [[:cntrl:]] covers the invisible format characters, so without that explicit
  // range the SQL would accept `창호/98/남/관악<ZWSP>` while the browser refused
  // it — a nickname indistinguishable on screen from one already taken.
  it('asks Postgres for the same character set the browser refuses', () => {
    expect(sql).toContain("v_nickname ~ '[[:space:]]' or v_nickname ~ '[^[:print:]]'")
  })

  // Both halves, and both are load-bearing: `[:print:]` admits NBSP while
  // `[:space:]` misses every zero-width character. Dropping either reopens the
  // hole — and the enumeration this replaced looked complete while leaving six
  // characters through.
  it('keeps both halves of the Postgres union', () => {
    const gate = sql.slice(sql.indexOf("if v_nickname ~ '[["))
    expect(gate).toContain("'[[:space:]]'")
    expect(gate).toContain("'[^[:print:]]'")
    // The enumeration is gone, not merely supplemented.
    expect(sql).not.toContain("U&'[\\00ad")
    expect(sql).not.toContain('[[:space:][:cntrl:]]')
  })

  // The guard that keeps the format from orphaning a roster member. It is
  // server-only by necessity — `anon` cannot read members, so the browser can
  // never answer this question — which makes the SQL the only place to pin it.
  it('refuses an applicant who is already on the roster, and does not link them', () => {
    expect(sql).toContain("'reason', 'existing_member'")
    expect(sql).toContain('lower(normalize(m.short_name, nfc)) = lower(v_parts[1])')
    expect(sql).toContain('m.birth_year % 100                  = v_parts[2]::int')
    expect(sql).toContain('m.gender                            = v_parts[3]')

    // `exists`, never an update: matching a name, a birth year and a gender must
    // not be enough to take over somebody's account and history.
    expect(sql).not.toContain('update public.members')
  })

  // NFC normalisation, which is what makes the guard above comparable at all.
  // Without it the guard reads a precomposed short_name against a possibly
  // decomposed submission and misses — proven live: precomposed refused
  // `existing_member`, the identical-looking decomposed form returned ok:true.
  it('normalises the nickname to NFC before judging or storing it', () => {
    expect(sql).toContain("v_nickname := normalize(btrim(coalesce(p_nickname, '')), nfc)")
    // Bare btrim would be the regression, and it is what was there before.
    expect(sql).not.toContain("v_nickname := btrim(coalesce(p_nickname, ''))")
  })
})

// ---------------------------------------------------------------------------
// The shape.
// ---------------------------------------------------------------------------

describe('checkNicknameFormat', () => {
  it('accepts the example the form shows', () => {
    expect(checkNicknameFormat(NICKNAME_FORMAT_EXAMPLE)).toBeNull()
    expect(NICKNAME_PATTERN.test(NICKNAME_FORMAT_EXAMPLE)).toBe(true)
  })

  it('accepts 여 as well as 남', () => {
    expect(checkNicknameFormat('영희/02/여/분당')).toBeNull()
  })

  // Name and region are free strings — the brief constrains only the year and
  // the gender. A one-character name, a long region, digits and Latin letters
  // all have to get through, or the rule is narrower than it was asked to be.
  it('leaves the name and the region as free text', () => {
    for (const ok of [
      '가/98/남/가',
      '김창호/98/남/서울특별시관악구',
      'changho/98/남/Gwanak',
      '창호2/98/남/관악3',
      '박-창호/00/여/제주',
    ]) {
      expect(checkNicknameFormat(ok), ok).toBeNull()
    }
  })

  // The cases a real person actually types.
  it('names the year when four digits were typed', () => {
    expect(checkNicknameFormat('창호/1998/남/관악')).toEqual({
      reason: 'nickname_year',
      message: '출생년도는 뒤 두 자리만 입력해주세요. 1998년생이면 98입니다.',
    })
  })

  it('names the gender when it is not 남 or 여', () => {
    for (const wrong of ['창호/98/M/관악', '창호/98/male/관악', '창호/98/남자/관악']) {
      expect(checkNicknameFormat(wrong)?.reason, wrong).toBe('nickname_gender')
    }
  })

  it('names the missing part when one was left out', () => {
    expect(checkNicknameFormat('창호/98/남')).toEqual({
      reason: 'nickname_parts',
      message: `닉네임은 이름/출생년도/성별/지역 형식으로 입력해주세요. 예: ${NICKNAME_FORMAT_EXAMPLE}`,
    })
  })

  // Spaces around the separators, which is what anyone laying the format out
  // legibly will type. Refused rather than quietly trimmed: the nickname becomes
  // the login address, and two nicknames that differ only in whitespace would be
  // two people the roster shows identically.
  it('refuses spaces around the separators', () => {
    expect(checkNicknameFormat('창호 / 98 / 남 / 관악')).toEqual({
      reason: 'nickname_invisible',
      message: `닉네임에는 공백이나 보이지 않는 문자를 넣을 수 없습니다. 예: ${NICKNAME_FORMAT_EXAMPLE}`,
    })
    expect(checkNicknameFormat('창 호/98/남/관악')?.reason).toBe('nickname_invisible')
  })

  it('refuses an empty region', () => {
    expect(checkNicknameFormat('창호/98/남/')).toEqual({
      reason: 'nickname_region',
      message: `지역을 입력해주세요. 예: ${NICKNAME_FORMAT_EXAMPLE}`,
    })
  })

  it('refuses an empty name', () => {
    expect(checkNicknameFormat('/98/남/관악')?.reason).toBe('nickname_name')
  })

  // A slash inside the name gets its own sentence, because "형식대로 쓰세요" does
  // not tell somebody whose name contains the separator what to do about it.
  it('says so when the name or the region contains a slash', () => {
    expect(checkNicknameFormat('창/호/98/남/관악')).toEqual({
      reason: 'nickname_slashes',
      message: `이름과 지역에는 /를 넣을 수 없습니다. 예: ${NICKNAME_FORMAT_EXAMPLE}`,
    })
    expect(checkNicknameFormat('창호/98/남/관악/서울')?.reason).toBe('nickname_slashes')
  })

  // ─────────────────────────────────────────────────────────────────────────
  // THE CASE LIST. This is deliberately a list of codepoints and not a parity
  // assertion against the server.
  //
  // An earlier version of this rule enumerated the invisible characters it knew
  // about, and the client and the server AGREED on all of them — the parity
  // test was green. Driven against the deployed function, six characters still
  // came back ok:true: U+061C, U+202A, U+202E, U+2066, U+2069, U+FFF9. Both
  // implementations had inherited the same blind spot, so checking them against
  // each other could never have found it.
  //
  // Agreement is not correctness. Every codepoint below is named on purpose.
  // ─────────────────────────────────────────────────────────────────────────
  it('refuses every whitespace, control and invisible-format codepoint', () => {
    const forbidden = [
      // Unicode White_Space.
      0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003,
      0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f,
      0x3000,
      // C0 controls, DEL, C1 controls.
      0x01, 0x08, 0x0e, 0x1b, 0x1f, 0x7f, 0x80, 0x9f,
      // Soft hyphen, the zero-width family, the word joiners, the BOM.
      0xad, 0x200b, 0x200c, 0x200d, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xfeff,
      // THE SIX THE ENUMERATION MISSED, plus their immediate relatives. Bidi
      // controls and isolates are category Cf, so neither [[:cntrl:]] nor
      // \p{Cc} covers them. U+202E is the dangerous one: it does not merely
      // hide, it reverses the display order of everything after it.
      0x61c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
      0x2066, 0x2067, 0x2068, 0x2069, 0xfff9, 0xfffa, 0xfffb,
    ]
    for (const cp of forbidden) {
      const ch = String.fromCodePoint(cp)
      expect(NICKNAME_FORBIDDEN.test(ch), `U+${cp.toString(16)}`).toBe(true)
      expect(checkNicknameFormat(`창호/98/남/관${ch}악`), `U+${cp.toString(16)}`).toEqual({
        reason: 'nickname_invisible',
        message: `닉네임에는 공백이나 보이지 않는 문자를 넣을 수 없습니다. 예: ${NICKNAME_FORMAT_EXAMPLE}`,
      })
    }

    // The two impersonation cases spelled out, because a codepoint loop makes
    // them look like bookkeeping. Both of these are a *different string* from
    // the example — so a unique index would hold them alongside it — while
    // rendering identically to it on every screen in the app.
    for (const invisible of [BOM, ZWSP]) {
      const lookalike = NICKNAME_FORMAT_EXAMPLE + invisible
      expect(lookalike).not.toBe(NICKNAME_FORMAT_EXAMPLE)
      expect(checkNicknameFormat(lookalike)?.reason).toBe('nickname_invisible')
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // DECOMPOSED HANGUL. Read this before deleting it as a duplicate of the
  // invisible-character list above — it is a DIFFERENT problem that happens to
  // look the same from the outside.
  //
  // The list above is about characters that cannot be SEEN. This is about the
  // SAME characters in a different encoding: `창호` as two precomposed
  // syllables or as five conjoining jamo. Jamo are printable and legitimate —
  // they are how Hangul is typed — so `\p{C}` and `[^[:print:]]` correctly have
  // nothing to say about them, and rejecting them would be wrong.
  //
  // The fix is therefore normalisation, not rejection, and it lives in
  // canonicalNickname() rather than in NICKNAME_FORBIDDEN. Deleting either one
  // reopens a hole the other never covered.
  // ─────────────────────────────────────────────────────────────────────────
  it('folds decomposed Hangul onto its precomposed form', () => {
    const decomposed = NICKNAME_FORMAT_EXAMPLE.normalize('NFD')

    // The premise: two strings, one rendering, and every ordinary comparison
    // says they differ.
    expect(decomposed).not.toBe(NICKNAME_FORMAT_EXAMPLE)
    expect(decomposed.length).toBeGreaterThan(NICKNAME_FORMAT_EXAMPLE.length)
    expect(decomposed.toLowerCase()).not.toBe(NICKNAME_FORMAT_EXAMPLE.toLowerCase())

    // And the character gate cannot help, correctly — jamo are printable.
    expect(NICKNAME_FORBIDDEN.test(decomposed)).toBe(false)

    // canonicalNickname is what closes it: one form out, whatever went in.
    expect(canonicalNickname(decomposed)).toBe(NICKNAME_FORMAT_EXAMPLE)
    expect(canonicalNickname(`  ${decomposed}  `)).toBe(NICKNAME_FORMAT_EXAMPLE)
    expect(canonicalNickname(NICKNAME_FORMAT_EXAMPLE)).toBe(NICKNAME_FORMAT_EXAMPLE)
  })

  it('accepts a decomposed nickname at signup, judging its canonical form', () => {
    const decomposed = '창호/98/남/관악'.normalize('NFD')
    expect(validateSignup({ nickname: decomposed, password: 'swimclub2026' })).toBeNull()
  })

  // The login half. The address is derived from the nickname and compared with
  // what the server stored, so a decomposed nickname computed a different
  // address than the member's own account and could not sign in — with nothing
  // on screen to say why, since LoginPage answers every failure the same way.
  it('derives one address whichever form the IME produced', () => {
    expect(emailForNickname('창호/98/남/관악'.normalize('NFD'))).toBe(
      '창호/98/남/관악@eysl.local',
    )
    expect(emailForNickname('영희'.normalize('NFD'))).toBe('영희@eysl.local')
  })

  // The other direction, which matters just as much: `\p{C}` is a wide net and
  // must not have caught anything a member might legitimately type. Emoji are
  // in here deliberately — the rule is about characters that cannot be SEEN,
  // not about narrowing the alphabet to Hangul.
  it('does not treat visible characters as forbidden', () => {
    for (const ch of ['가', '힣', '9', '/', '-', 'a', 'Z', '·', '€', '😀', 'ー', '漢']) {
      expect(NICKNAME_FORBIDDEN.test(ch), ch).toBe(false)
    }
    expect(checkNicknameFormat('창호2/98/남/관악😀')).toBeNull()
  })

  // The invariant that makes the six branches safe to have: the diagnosis and
  // the shared pattern must agree on every input, or one of them is lying.
  it('agrees with the shared pattern on every case in this file', () => {
    const corpus = [
      NICKNAME_FORMAT_EXAMPLE,
      '영희/02/여/분당',
      '가/98/남/가',
      'changho/98/남/Gwanak',
      '창호/1998/남/관악',
      '창호/9/남/관악',
      '창호/98/M/관악',
      '창호/98/남',
      '창호/98',
      '창호',
      '/98/남/관악',
      '창호/98/남/',
      '창호//남/관악',
      '창/호/98/남/관악',
      '창호/98/남/관악/서울',
      '창호 / 98 / 남 / 관악',
      '철수',
      '영희',
      '관리자',
      '',
      '////',
      NICKNAME_FORMAT_EXAMPLE + BOM,
    ]

    for (const nickname of corpus) {
      const wellFormed = checkNicknameFormat(nickname) === null
      const matchesPattern = NICKNAME_PATTERN.test(nickname) && !NICKNAME_FORBIDDEN.test(nickname)
      expect(wellFormed, `${JSON.stringify(nickname)} disagreed`).toBe(matchesPattern)
    }
  })
})

// ---------------------------------------------------------------------------
// The forty-one people already in the database.
// ---------------------------------------------------------------------------
//
// This is the constraint the whole design bends around. The dev database holds
// 41 members imported from the club's spreadsheet and 37 of them do not match
// the format (measured 2026-08-26). A CHECK constraint would have refused all of
// those, and would have kept refusing them on every later UPDATE to any column.
//
// The nicknames below have the SHAPE of the rows in that database — a short
// given name of two or three syllables — but they are the Korean John Doe, not
// the club's actual ones. This repository is public; the counts above prove the
// point without publishing forty people's names to prove it.
//
// So the rule applies to signup and nowhere else, and these tests are what say
// so — they fail the moment somebody widens it into a path that existing
// members travel.

describe('the members who joined before the rule existed', () => {
  const existing = ['철수', '영희', '길동', '관리자', 'pwtestadmin', '엠에스관리자']

  it('is refused at signup, since these are exactly what the format replaces', () => {
    for (const nickname of existing) {
      expect(checkNicknameFormat(nickname), nickname).not.toBeNull()
    }
  })

  // The load-bearing half. Every one of these still has to log in, be parsed
  // into a CurrentUser and be displayed — the format governs who may *join*, not
  // who already has.
  it('still derives a login address', () => {
    expect(emailForNickname('철수')).toBe('철수@eysl.local')
    expect(emailForNickname('  영희  ')).toBe('영희@eysl.local')
    expect(emailForNickname('관리자')).toBe('관리자@eysl.local')
  })

  it('still parses as a member row', () => {
    for (const nickname of existing) {
      const row = {
        id: '00000000-0000-4000-8000-000000000001',
        nickname,
        real_name: null,
        avatar_path: null,
        role: 'member' as const,
        status: 'approved' as const,
      }
      expect(() => memberSchema.parse(row), nickname).not.toThrow()
      expect(memberSchema.parse(row).nickname).toBe(nickname)
    }
  })

  // A new nickname in the new format must also survive everything above, or the
  // format would be enforceable but unusable. The address is the interesting
  // half: it now carries slashes, and GoTrue was asked directly whether it would
  // still sign one in (HTTP 200, real token) before the format was settled.
  it('coexists with a nickname in the new format', () => {
    expect(emailForNickname(NICKNAME_FORMAT_EXAMPLE)).toBe('창호/98/남/관악@eysl.local')
    expect(
      memberSchema.parse({
        id: '00000000-0000-4000-8000-000000000002',
        nickname: NICKNAME_FORMAT_EXAMPLE,
        real_name: null,
        avatar_path: null,
        role: 'member',
        status: 'pending',
      }).nickname,
    ).toBe(NICKNAME_FORMAT_EXAMPLE)
  })
})

// ---------------------------------------------------------------------------
// Where the rule actually bites.
// ---------------------------------------------------------------------------

describe('validateSignup with the format rule', () => {
  const password = 'swimclub2026'

  it('accepts a well-formed nickname', () => {
    expect(validateSignup({ nickname: NICKNAME_FORMAT_EXAMPLE, password })).toBeNull()
  })

  it('trims the ends before judging the shape', () => {
    expect(validateSignup({ nickname: `  ${NICKNAME_FORMAT_EXAMPLE}  `, password })).toBeNull()
  })

  it('passes the format sentence straight through', () => {
    expect(validateSignup({ nickname: '창호/1998/남/관악', password })).toBe(
      '출생년도는 뒤 두 자리만 입력해주세요. 1998년생이면 98입니다.',
    )
  })

  // Order matters and is deliberately the server's. `수` is short *and*
  // malformed; complaining about length first is what register_member_v1 does,
  // so it is what the screen does.
  it('still complains about length before shape', () => {
    expect(validateSignup({ nickname: '수', password })).toBe('닉네임은 2자 이상 입력해주세요.')
    expect(validateSignup({ nickname: '가'.repeat(31), password })).toBe(
      '닉네임은 30자 이하로 입력해주세요.',
    )
  })

  // And the password rules come after the nickname's, so a malformed nickname
  // with a short password names the nickname.
  it('checks the nickname before the password', () => {
    expect(validateSignup({ nickname: '창호/98/M/관악', password: 'short' })).toBe(
      `성별은 남 또는 여로 입력해주세요. 예: ${NICKNAME_FORMAT_EXAMPLE}`,
    )
  })
})
