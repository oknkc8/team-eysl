import type { Role } from '../auth/schema'

/**
 * The club's own label for a member, separate from the account role.
 *
 * members.team_role is free text with no CHECK, and one of its values decides
 * who may upload 결과지 — can_manage_records() (0004:167) compares it against
 * the literal '코치'. That combination is why this is a fixed list rather than
 * a text field: '코 치' saves without error and silently takes the right away.
 */

// Exactly what set_member_team_role_v1 accepts (0011). Kept in the same shape
// as ASSIGNABLE_ROLES in api.ts and for the same reason: offering a value the
// function refuses is building a control whose only outcome is an error.
export const ASSIGNABLE_TEAM_ROLES = ['코치', '부관리자'] as const

export type AssignableTeamRole = (typeof ASSIGNABLE_TEAM_ROLES)[number]

/**
 * The only team role that changes what anybody can do.
 *
 * '부관리자' is assignable because it exists in the legacy data — index.html:3720
 * compares against it — but nothing reads it: both branches of that ternary
 * produce the same label. Say so where it is offered, so a master admin does not
 * grant it expecting rights it does not carry.
 */
export const RECORD_MANAGER_TEAM_ROLE: AssignableTeamRole = '코치'

export function isAssignableTeamRole(value: string | null | undefined): value is AssignableTeamRole {
  return ASSIGNABLE_TEAM_ROLES.includes(value as AssignableTeamRole)
}

/**
 * What the picker should show for a member's current value.
 *
 * The third case is the one worth having a type for. The president's roster may
 * carry words this app never offers, and 0011 deliberately leaves them alone:
 * the allow-list governs writes, not rows that already exist. So an
 * unrecognised value is rendered as itself rather than as 지정 안 함, which
 * would tell a master admin the field is empty right before they overwrite it.
 */
export type TeamRoleChoice =
  | { kind: 'none' }
  | { kind: 'assignable'; value: AssignableTeamRole }
  | { kind: 'unknown'; value: string }

export function teamRoleChoice(value: string | null | undefined): TeamRoleChoice {
  // Whitespace-only counts as 지정 안 함, matching the nullif(btrim(...)) the
  // function applies before storing — so the screen and the database agree on
  // what "empty" means instead of disagreeing by one space.
  const trimmed = (value ?? '').trim()
  if (trimmed === '') return { kind: 'none' }
  if (isAssignableTeamRole(trimmed)) return { kind: 'assignable', value: trimmed }
  return { kind: 'unknown', value: trimmed }
}

/**
 * Mirrors can_manage_records() (0004:159-169), for display only.
 *
 * The database is what decides — upsert_record() raises 42501 no matter what
 * this returns. It exists so the roles screen can say out loud that granting
 * 코치 hands somebody 결과지 업로드, which is the whole reason the value is
 * load-bearing and the reason a typo in it is expensive.
 */
export function grantsRecordUpload(input: { role: Role; teamRole: string | null }): boolean {
  if (input.role === 'admin' || input.role === 'master_admin') return true
  return (input.teamRole ?? '').trim() === RECORD_MANAGER_TEAM_ROLE
}
