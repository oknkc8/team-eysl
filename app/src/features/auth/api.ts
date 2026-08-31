import { supabase } from '../../lib/supabase'
import { memberSchema, type CurrentUser } from './schema'
import { canonicalNickname } from './nickname'
import { readSignupResult, type SignupInput, type SignupRefusal } from './signup'

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
    .select('id, nickname, real_name, avatar_path, role, status, team_role')
    .eq('auth_user_id', authUserId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  // Parsed rather than cast: the generated types describe the schema as it was
  // when generated, not as the server answers today.
  return memberSchema.parse(data)
}

/**
 * 가입 신청. Creates the auth account and the pending members row together.
 *
 * WHY NOT auth.signUp. It cannot work on this project and never could: GoTrue
 * validates deliverability on signup and answers 400 email_address_invalid for
 * `<nickname>@eysl.local`, because `.local` does not resolve. The same address is
 * accepted by signInWithPassword, which is why this stayed invisible for so long
 * — login worked against hand-seeded rows while account creation was dead. 0028
 * moves the work into register_member_v1(), a SECURITY DEFINER function that
 * writes the auth rows itself. The trade-off that buys is written out in full at
 * the head of that migration; the short version is that we are in somebody
 * else's schema until a service-role key exists for an Edge Function to hold.
 *
 * There is deliberately no second call here inserting into `members`. The
 * on_auth_user_created trigger (0027) does that inside the same transaction as
 * the auth.users insert, so the account and the pending member row commit
 * together — a two-step client flow could be abandoned between the steps and
 * leave an account that can sign in forever with no member behind it, which
 * RequireAuth renders as a permanent loading screen and no admin screen can see.
 *
 * The nickname and the password are the only things the browser gets to decide,
 * and that is enforced by the shape of the call rather than by trust: the RPC
 * takes exactly two named arguments, and PostgREST resolves a function by
 * argument name, so a body carrying `status` or `role` does not get them
 * ignored — it matches no function at all. Verified against the dev project: the
 * same call with `"status":"approved","role":"master_admin"` added came back
 * PGRST202, and the account created by the clean call landed pending/member.
 *
 * Returns null when the account was created, or the refusal to show. Only
 * transport failures throw; the screen turns those into a sentence with
 * signupErrorMessage().
 */
export async function registerMember(input: SignupInput): Promise<SignupRefusal | null> {
  // canonicalNickname, not .trim(). register_member_v1 normalises to NFC too, so
  // this does not change what gets stored — but sending the canonical form keeps
  // the string the screen validated identical to the string the server judges,
  // which is what makes a refusal explicable.
  const { data, error } = await supabase.rpc('register_member_v1', {
    p_nickname: canonicalNickname(input.nickname),
    p_password: input.password,
  })
  if (error) throw error
  return readSignupResult(data)
}
