import { z } from 'zod'
import { canonicalNickname } from './nickname'

export const roleSchema = z.enum(['member', 'admin', 'master_admin'])
export const memberStatusSchema = z.enum(['pending', 'approved', 'rejected', 'blocked'])

export const memberSchema = z.object({
  id: z.string().uuid(),
  nickname: z.string(),
  real_name: z.string().nullable(),
  avatar_path: z.string().nullable(),
  role: roleSchema,
  status: memberStatusSchema,
  // Nullable free text, not an enum: 팀 역할 is the club's own vocabulary
  // (코치, 주장, …) and members.team_role has no CHECK constraint. Parsing it
  // as an enum would make a role the club invents next season a login failure.
  team_role: z.string().nullable(),
})

export type CurrentUser = z.infer<typeof memberSchema>
export type Role = z.infer<typeof roleSchema>

export const isStaff = (u: CurrentUser | null | undefined) =>
  u?.role === 'admin' || u?.role === 'master_admin'

// Separate from isStaff because one screen needs the narrower answer: only a
// master admin may change roles, and set_member_role_v1() refuses anyone else.
export const isMasterAdmin = (u: CurrentUser | null | undefined) => u?.role === 'master_admin'

/**
 * Mirrors can_manage_records() (0004:159-169) — admin, master_admin, or a
 * member whose 팀 역할 is 코치.
 *
 * WIDER THAN isStaff, AND THAT IS THE POINT. A coach is not staff: they cannot
 * approve members or edit the schedule. They can file swim records, and the
 * database has said so since 0004. The president's app agrees by name — his
 * refusal reads 총관리자·부관리자·코치만 결과지를 업로드할 수 있습니다
 * (final93:4217).
 *
 * Presentation only, like isStaff: upsert_record() and the record_uploads
 * policies check can_manage_records() themselves, so this decides what renders
 * and never what the server accepts.
 */
export const canManageRecords = (u: CurrentUser | null | undefined) =>
  isStaff(u) || u?.team_role === '코치'

// Dev login maps a nickname onto a synthetic address. The legacy app posts to a
// `login-member` edge function whose source lives in the president's project, so
// we can neither read nor deploy it; production cutover has to confirm its real
// semantics separately.
//
// canonicalNickname() rather than .trim(): NFC, then lowercased. The address is
// derived here and compared against what register_member_v1 stored, which is
// `lower(normalize(btrim(…), nfc))`. Without the normalisation a member whose
// IME emits decomposed jamo — visually identical Hangul — computes a DIFFERENT
// address from their own account and simply cannot sign in. LoginPage answers
// every failure with one deliberately vague sentence, so this would have been
// invisible from the outside: the right password, refused, with no explanation
// available to the person or to whoever they asked for help.
export const emailForNickname = (nickname: string) =>
  `${canonicalNickname(nickname).toLowerCase()}@eysl.local`
