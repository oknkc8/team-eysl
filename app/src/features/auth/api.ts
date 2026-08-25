import { supabase } from '../../lib/supabase'
import { memberSchema, emailForNickname, type CurrentUser } from './schema'
import type { SignupInput } from './signup'

/**
 * The signed-in member's own row.
 *
 * The `.eq('auth_user_id', …)` is load-bearing and was missing. members_read
 * (0001:172-174) is `auth_user_id = auth.uid() or is_staff()`, so an unfiltered
 * select hands a **staff** caller the entire roster — and `.maybeSingle()`
 * tolerates zero rows but not several. Reproduced against the dev project
 * through the real API, signed in as a master admin with two members present:
 *
 *   getMyMember() as written        : FAILS PGRST116 multiple (or no) rows
 *   same query filtered by auth uid : ok -> 엠에스관리자
 *
 * The failure mode is the worst shape available: useCurrentUser surfaces
 * `user: null`, RequireAuth reaches `if (!user) return <Loading />`, and every
 * admin — including the only person who can approve anybody — sits on a loading
 * screen forever. It stayed invisible because it needs a second member to
 * appear, and until 0027 nothing could create one.
 *
 * The id comes from the caller rather than from another `getUser()` round trip:
 * useCurrentUser already holds the session and keys its cache on the same value.
 */
export async function getMyMember(authUserId: string): Promise<CurrentUser | null> {
  const { data, error } = await supabase
    .from('members')
    .select('id, nickname, real_name, avatar_path, role, status')
    .eq('auth_user_id', authUserId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  // Parsed rather than cast: the generated types describe the schema as it was
  // when generated, not as the server answers today.
  return memberSchema.parse(data)
}

/**
 * 가입 신청. Creates the auth account; the members row follows from it.
 *
 * There is deliberately no second call here inserting into `members`. The
 * on_auth_user_created trigger (0027) does that inside GoTrue's own transaction,
 * so the account and the pending member row commit together — a two-step client
 * flow could be abandoned between the steps and leave an account that can sign
 * in forever with no member behind it, which RequireAuth renders as a permanent
 * loading screen and no admin screen can see.
 *
 * `nickname` in `options.data` is the only thing the browser gets to decide.
 * status and role are not sent, cannot be sent, and would be ignored if they
 * were: the trigger never reads them out of the metadata, so the row lands
 * 'pending'/'member' whatever this object contains. Verified against the dev
 * database — a signup posting {"status":"approved","role":"master_admin"}
 * produced status=pending, role=member.
 *
 * Throws the AuthError as-is; the screen turns it into a sentence with
 * signupErrorMessage().
 */
export async function registerMember(input: SignupInput): Promise<void> {
  const { error } = await supabase.auth.signUp({
    email: emailForNickname(input.nickname),
    password: input.password,
    options: { data: { nickname: input.nickname.trim() } },
  })
  if (error) throw error
}
