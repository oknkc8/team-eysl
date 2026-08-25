import { supabase } from '../../lib/supabase'
import { AVATAR_BUCKET } from '../members/api'
import type { Role } from '../auth/schema'
import { avatarObjectPath } from './avatarPath'

// Matches the roster's TTL: long enough for a slow phone to finish painting,
// short enough that a URL copied out of the page stops working.
const AVATAR_URL_TTL_SECONDS = 600

/** His own limit (upstream:3609): an image, and no larger than 5MB. */
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024

export type MyProfile = {
  id: string
  nickname: string
  real_name: string | null
  avatar_path: string | null
  /** Signed on read; null when there is no photo or the signature failed. */
  avatar_url: string | null
  role: Role
  status: string
}

const PROFILE_COLUMNS = 'id, nickname, real_name, avatar_path, role, status'

function toRole(value: string | null): Role {
  if (value === 'master_admin') return 'master_admin'
  if (value === 'admin') return 'admin'
  return 'member'
}

/**
 * The refusal to show for a file the bucket would not want, or null.
 *
 * Checked here as well as server-side because the alternative is a member
 * waiting for a 30MB upload to finish before being told it was never allowed.
 * The database is still what decides: the storage policy refuses any key outside
 * `<my member id>/<name>` whatever this function says.
 */
export function validateAvatarFile(file: { type: string; size: number }): string | null {
  if (!file.type.startsWith('image/')) return '이미지 파일만 등록할 수 있습니다.'
  if (file.size > MAX_AVATAR_BYTES) return '프로필 사진은 5MB 이하로 올려주세요.'
  return null
}

async function signAvatar(path: string | null): Promise<string | null> {
  if (!path) return null
  const { data, error } = await supabase.storage
    .from(AVATAR_BUCKET)
    .createSignedUrl(path, AVATAR_URL_TTL_SECONDS)
  // A photo that will not sign falls back to the initial, which MemberAvatar
  // treats as a first-class rendering rather than a broken image.
  if (error) return null
  return data?.signedUrl ?? null
}

/** The auth user id, or null when there is no session to read it from. */
async function currentAuthUserId(): Promise<string | null> {
  const { data, error } = await supabase.auth.getUser()
  if (error) return null
  return data.user?.id ?? null
}

/**
 * The signed-in member's own profile.
 *
 * Filtered by auth_user_id for the same reason getMyMember is: members_read
 * hands a staff caller every row, and `.maybeSingle()` refuses more than one.
 */
export async function getMyProfile(): Promise<MyProfile> {
  const authUserId = await currentAuthUserId()
  if (!authUserId) throw new Error('로그인 정보를 확인할 수 없습니다')

  const { data, error } = await supabase
    .from('members')
    .select(PROFILE_COLUMNS)
    .eq('auth_user_id', authUserId)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new Error('회원 정보를 찾을 수 없습니다')

  return {
    id: data.id,
    nickname: data.nickname,
    real_name: data.real_name,
    avatar_path: data.avatar_path,
    avatar_url: await signAvatar(data.avatar_path),
    role: toRole(data.role),
    status: data.status,
  }
}

/**
 * 실명 저장.
 *
 * The value the result-sheet parser matches on: `matchRealName`
 * (records/parser/roster.ts) compares a printed name against this column
 * exactly, and a member whose 실명 is unset never appears in the roster it
 * searches — so their times land as unmatched rows an admin resolves by hand.
 * That is the whole reason the screen asks for it.
 *
 * The length rule lives in set_my_real_name_v1 (0027) too; this call simply lets
 * the server refuse, which is why the message it raises is already Korean.
 */
export async function setMyRealName(realName: string): Promise<void> {
  const { error } = await supabase.rpc('set_my_real_name_v1', { p_real_name: realName })
  if (error) throw error
}

/**
 * The path currently on the row, asked of the server rather than passed in.
 *
 * The screen's copy can be stale — a photo changed on another device, or a save
 * that failed without being noticed — and removing the wrong object is not
 * recoverable.
 */
async function currentAvatarPath(): Promise<string | null> {
  const authUserId = await currentAuthUserId()
  if (!authUserId) return null

  const { data } = await supabase
    .from('members')
    .select('avatar_path')
    .eq('auth_user_id', authUserId)
    .maybeSingle()
  return data?.avatar_path ?? null
}

/**
 * Replace the member's photo.
 *
 * Ordered so no step can leave the profile pointing at nothing, which is the
 * order his app uses (upstream:3609):
 *
 *   1. upload to a fresh key with upsert:false — the old object is untouched,
 *      and a colliding key fails here rather than overwriting somebody's file
 *   2. record the new path; if that fails, remove what was just uploaded and
 *      raise, leaving the old photo still the live one
 *   3. only then remove the old object
 *
 * The other order — clear, then upload — leaves a member with no photo whenever
 * the upload fails.
 */
export async function uploadMyAvatar(input: { memberId: string; file: File }): Promise<void> {
  const refusal = validateAvatarFile(input.file)
  if (refusal) throw new Error(refusal)

  const previous = await currentAvatarPath()
  const path = avatarObjectPath({ memberId: input.memberId, fileName: input.file.name })

  const upload = await supabase.storage
    .from(AVATAR_BUCKET)
    .upload(path, input.file, { upsert: false, contentType: input.file.type })
  if (upload.error) throw upload.error

  const { error } = await supabase.rpc('set_my_avatar_path_v1', { p_avatar_path: path })
  if (error) {
    // Best effort: if this also fails the object is orphaned, which costs
    // storage but leaves the profile correct. The reverse would not.
    await supabase.storage.from(AVATAR_BUCKET).remove([path])
    throw error
  }

  if (previous) await supabase.storage.from(AVATAR_BUCKET).remove([previous])
}

/**
 * 사진 삭제.
 *
 * The row is cleared before the object, so a failure between the two leaves an
 * unreferenced file rather than a profile pointing at a photo that is gone.
 * '' rather than null is the wire convention set_my_avatar_path_v1 expects — the
 * generated Args type declares the parameter as a plain string, and the function
 * turns both spellings of empty into NULL.
 */
export async function removeMyAvatar(): Promise<void> {
  const previous = await currentAvatarPath()

  const { error } = await supabase.rpc('set_my_avatar_path_v1', { p_avatar_path: '' })
  if (error) throw error

  if (previous) await supabase.storage.from(AVATAR_BUCKET).remove([previous])
}
