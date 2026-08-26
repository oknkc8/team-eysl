// The 닉네임 format, and the only place its shape is written down.
//
// `{이름}/{출생년도 2자리}/{남|여}/{지역}` — 창호/98/남/관악.
//
// ============================================================================
// WHY THIS IS NOT A CHECK CONSTRAINT ON members.nickname
// ============================================================================
//
// The dev database holds 41 member rows imported from the club's own
// spreadsheet, and almost none of them match this format — they are short given
// names of two or three syllables. The examples used throughout this file and
// its tests (철수, 영희, 길동) are the Korean equivalents of John Doe, NOT the
// club's actual nicknames: this repository is public, and publishing the given
// names of forty identifiable people to prove a regex would be a poor trade.
// Measured rather than assumed, 2026-08-26:
//
//   select count(*), count(*) filter (where nickname !~ '<this pattern>')
//     from public.members;   ->   41 | 37
//
// It read 41 | 41 an hour earlier. Four of the imported members were renamed
// into the format by hand while this was being written, which is worth knowing
// for two reasons: the number will keep moving, and it moved by UPDATE on
// existing rows — precisely the statement a CHECK constraint would have blocked.
//
// A CHECK, a domain, or a validating trigger would refuse every one of those
// rows, and not only on INSERT: a CHECK is re-evaluated on UPDATE, so the first
// admin who changed anybody's 실명 or avatar would be refused too. The club's
// real roster is not a migration problem to be tidied away — those are people
// who joined before the rule existed.
//
// So the rule lives on the *signup path* instead, in exactly two places:
//
//   * here, so the form can say which part is wrong before anyone submits;
//   * register_member_v1() in 0032, because a direct RPC call never sees a form.
//
// The client half is a courtesy. The server half is the rule.
//
// ============================================================================
// THE DUPLICATION, AND WHAT KEEPS IT HONEST
// ============================================================================
//
// The pattern below is one string, and 0032 hands that same string to Postgres's
// `~`. nickname.test.ts reads the migration off disk and fails if the two ever
// stop being byte-identical — editing one without the other is a red test, not a
// silent divergence discovered in production.

/** What the form shows, what the errors quote, and what the tests use. */
export const NICKNAME_FORMAT_EXAMPLE = '창호/98/남/관악'

/**
 * The one canonical form of a nickname: trimmed, then NFC.
 *
 * ============================================================================
 * WHY NORMALISATION IS A SECURITY CONTROL HERE AND NOT A TIDINESS HABIT
 * ============================================================================
 *
 * Hangul has two encodings that render IDENTICALLY. `창호` can be two
 * precomposed syllables (NFC) or five conjoining jamo (NFD), and a Korean IME
 * can emit either. Nothing in this file could tell them apart, and neither
 * could the database:
 *
 *   nfc_len 2   nfd_len 5   equal false   lower(nfc)=lower(nfd) false
 *   both match ^[^/]+$ ................. the pattern has no opinion
 *   nfd caught by [^[:print:]] .. FALSE . jamo are legitimate printable
 *                                          characters and must not be refused
 *
 * So all three of the defences around this rule were blind to it at once:
 *
 *   - members_nickname_lower_uq  — `lower()` does not normalise, so both forms
 *     can sit in the table as separate rows.
 *   - the roster guard in 0032   — `short_name` is precomposed, the submitted
 *     name was not, the comparison missed, and a member with eleven years of
 *     attendance was treated as a newcomer.
 *   - NICKNAME_FORBIDDEN below   — jamo are printable, correctly.
 *
 * Proven against the deployed function, with the roster row chosen by the
 * database: the precomposed name was refused `existing_member`, and the same
 * name decomposed returned `ok:true` — a second row for a real member, holding
 * the login while the original held the history. The two render the same, so no
 * screen could show which was which; it takes `nickname <> normalize(nickname,
 * NFC)` to see it at all.
 *
 * THIS IS ALSO A LOGIN FIX, not only a signup one. emailForNickname() derives
 * the address from the nickname, so before this a member whose IME produced NFD
 * would compute a different address from the one stored and simply fail to sign
 * in, with nothing on screen to explain why.
 *
 * Trim first, then normalise — the same order as `normalize(btrim(…), nfc)` in
 * 0032, so the client and the server cannot disagree about a nickname that has
 * both leading space and decomposed jamo.
 */
export const canonicalNickname = (value: string) => value.trim().normalize('NFC')

/**
 * The shape, as one string shared with the server.
 *
 * Deliberately written to mean the same thing in both engines: `[^/]`, `{2}`,
 * `(a|b)`, `^` and `$` are spelled and interpreted identically by JavaScript's
 * `u`-mode RegExp and PostgreSQL's ARE. There is no `\s`, `\d` or `\w` in it —
 * see NICKNAME_FORBIDDEN below for why those were avoided.
 *
 * Name and region are free text (`[^/]+`); only the separator count, the year
 * and the gender are constrained.
 */
export const NICKNAME_PATTERN_SOURCE = '^[^/]+/[0-9]{2}/(남|여)/[^/]+$'

export const NICKNAME_PATTERN = new RegExp(NICKNAME_PATTERN_SOURCE, 'u')

/**
 * Characters a nickname may not contain — asked separately from the pattern.
 *
 * `창호 / 98 / 남 / 관악` has to be refused, and the obvious fix, putting a class
 * inside the pattern, is the one thing that could NOT be shared. `[^/[:space:]]`
 * means "not /, [, :, s, p, a, c, e, ]" to JavaScript and something else
 * entirely to Postgres, so a pattern carrying a POSIX class stops being one
 * string with one meaning. Hence a separate gate, spelled in each engine's own
 * idiom, for the one set defined here.
 *
 * IT TOOK FOUR ROUNDS TO GET THIS RIGHT, AND THE SHAPE OF THE MISTAKE REPEATED
 * EACH TIME. Every version was a set that CONTAINED most invisible characters
 * rather than a set that MEANT "invisible":
 *
 *   1. U+FEFF alone            — the BOM has relatives
 *   2. + a hand-written range  — missed U+061C, U+202A, U+202E, U+2066, U+2069,
 *                                U+FFF9, all category Cf
 *   3. `\p{C}` / `[^[:print:]]`— missed U+034F and the variation selectors
 *                                U+FE00-FE0F, which are category Mn
 *   4. + Default_Ignorable_Code_Point ....... the property that is actually
 *                                             ABOUT invisibility
 *
 * Each round the fix was "use a class, not a list", and each round the class was
 * narrower than the thing being described. `Default_Ignorable_Code_Point` is
 * Unicode's own answer to "characters that should not be visible": 4174
 * codepoints in 17 ranges, covering the zero-width family, the bidi controls and
 * isolates, U+034F COMBINING GRAPHEME JOINER, the variation selectors, the tag
 * characters, and — worth noting for this app specifically — U+3164 HANGUL
 * FILLER and the jamo fillers U+115F/U+1160.
 *
 * `\s` and `\p{C}` are kept alongside it because the property does NOT subsume
 * them: it contains no ordinary whitespace and not the C0 controls.
 *
 * THE SQL SIDE ENUMERATES, because Postgres has no `\p{}` — but it enumerates a
 * NAMED PROPERTY generated from the engine, not characters somebody recalled.
 * Its three arms are `[[:space:]]`, `[^[:print:]]` and an explicit 17-range
 * bracket expression. Both halves of the first two are load-bearing: `[:print:]`
 * admits NBSP and `[:space:]` misses every zero-width character.
 *
 * MEASURED at every one of the 17 range boundaries plus one codepoint either
 * side — 62 in all, zero disagreements. Hangul, Latin, digits, `/` and `€` pass.
 *
 * ONE DELIBERATE COST: an emoji carrying a variation selector (❤️ is U+2764
 * U+FE0F) is now REFUSED, where a bare emoji (😀) still passes. VS16 is exactly
 * the kind of invisible modifier this rule exists to stop, and a nickname is
 * 이름/출생년도/성별/지역 rather than a place for decorated emoji, so the trade is
 * worth naming rather than discovering.
 *
 * AND THE PART WORTH KEEPING: at round 2 the two implementations AGREED and were
 * both wrong — a parity test between client and server passed on all six leaks.
 * That is why nickname.test.ts pins explicit codepoints rather than asserting
 * the two sides match. Agreement is not correctness when both sides inherited
 * the same blind spot.
 *
 * The earlier White_Space measurement still stands and is why `\s` is kept:
 * across the 26 White_Space codepoints, JavaScript `\s` and Postgres
 * `[[:space:]]` disagree on exactly two — U+0085 NEL (Postgres only) and U+FEFF
 * (JavaScript only). Both are now covered several times over.
 */
export const NICKNAME_FORBIDDEN = /[\s\p{C}\p{Default_Ignorable_Code_Point}]/u

/** Why a nickname was turned down, in the same shape register_member_v1 returns. */
export type NicknameRefusal = {
  /** Matches the server's `reason` exactly: `nickname_invisible`, `nickname_year`, … */
  reason: string
  /** The Korean sentence to show. Byte-identical to the server's. */
  message: string
}

/**
 * Which part of the nickname is wrong, or null when it is well-formed.
 *
 * A single boolean against NICKNAME_PATTERN would be shorter and would tell
 * somebody who typed `창호/1998/남/관악` only that their nickname is invalid,
 * leaving them to guess which of four parts to change. The order of the checks
 * below is the order that produces the most useful sentence: forbidden
 * characters first, because a space around a separator otherwise surfaces as a
 * confusing complaint about the name, then the separator count, then each part
 * in reading order.
 *
 * WHAT THIS CANNOT ANSWER, and it is the important half: whether the person
 * typing is already on the club roster. That question needs the members table,
 * which `anon` cannot read and this module never sees. register_member_v1 (0032)
 * asks it, and the browser only ever renders the sentence it gets back.
 *
 * Expects a nickname already put through canonicalNickname() — trimmed and NFC.
 * validateSignup does that, and register_member_v1 does the same thing in SQL.
 * Passing a decomposed string straight in would be checked correctly but would
 * then be compared against a precomposed roster, which is the bypass this
 * module's header describes.
 */
export function checkNicknameFormat(nickname: string): NicknameRefusal | null {
  if (NICKNAME_FORBIDDEN.test(nickname))
    return {
      reason: 'nickname_invisible',
      message: `닉네임에는 공백이나 보이지 않는 문자를 넣을 수 없습니다. 예: ${NICKNAME_FORMAT_EXAMPLE}`,
    }

  const parts = nickname.split('/')

  // Split rather than merged with the case below: somebody who typed a name with
  // a slash in it has a different problem from somebody who left a part out, and
  // "/를 넣을 수 없습니다" is the only sentence that tells them so.
  if (parts.length > 4)
    return {
      reason: 'nickname_slashes',
      message: `이름과 지역에는 /를 넣을 수 없습니다. 예: ${NICKNAME_FORMAT_EXAMPLE}`,
    }

  if (parts.length < 4)
    return {
      reason: 'nickname_parts',
      message: `닉네임은 이름/출생년도/성별/지역 형식으로 입력해주세요. 예: ${NICKNAME_FORMAT_EXAMPLE}`,
    }

  // Defaulted rather than asserted. The length check above guarantees all four
  // are present, but `noUncheckedIndexedAccess` types them `string | undefined`
  // and it is right to: the guarantee lives in a separate statement, not in the
  // type. `''` is the honest stand-in — every branch below already treats an
  // empty part as the refusal it would be — so the compiler is satisfied without
  // a `!` that would quietly outlive the check it depends on.
  const [name = '', year = '', gender = '', region = ''] = parts

  if (name === '')
    return {
      reason: 'nickname_name',
      message: `이름을 입력해주세요. 예: ${NICKNAME_FORMAT_EXAMPLE}`,
    }

  // The mistake to expect, and the reason this message names a year instead of
  // saying "두 자리": somebody born in 1998 types 1998, and being told the field
  // wants two digits does not tell them which two.
  if (!/^[0-9]{2}$/u.test(year))
    return {
      reason: 'nickname_year',
      message: '출생년도는 뒤 두 자리만 입력해주세요. 1998년생이면 98입니다.',
    }

  if (gender !== '남' && gender !== '여')
    return {
      reason: 'nickname_gender',
      message: `성별은 남 또는 여로 입력해주세요. 예: ${NICKNAME_FORMAT_EXAMPLE}`,
    }

  if (region === '')
    return {
      reason: 'nickname_region',
      message: `지역을 입력해주세요. 예: ${NICKNAME_FORMAT_EXAMPLE}`,
    }

  return null
}
