/**
 * Naming for objects in the team-files bucket.
 *
 * The first path segment is the uploader's member id, and that is load-bearing
 * rather than tidy: team_files_insert (0009) compares
 * `(storage.foldername(name))[1]` against current_member_id(), so a path that
 * does not start with the caller's own id is refused by the database.
 */

// Mirrors the legacy sanitizer (index.html:2731) so a file uploaded before and
// after the rewrite lands under the same shape of key. \w covers ASCII letters,
// digits and underscore; 가-힣 keeps a Korean filename readable instead of
// flattening it into a row of underscores.
const UNSAFE = /[^\w.\-가-힣]+/g

export function safeObjectName(fileName: string | null | undefined): string {
  const cleaned = (fileName ?? '').replace(UNSAFE, '_')
  // A name that sanitized away to nothing would leave a key ending in '_',
  // which reads as a missing file rather than an unnamed one.
  return cleaned === '' || cleaned === '_' ? 'file' : cleaned
}

/**
 * `<memberId>/media/<millis>_<nonce>_<name>`.
 *
 * The timestamp and nonce are what stop two people uploading 사진.jpg from
 * colliding — the upload is issued with upsert:false, so a shared key would
 * fail the second uploader rather than quietly replacing the first one's file.
 * Both are injectable so a test can assert the whole string.
 *
 * THIS UNIQUENESS IS NOW LOAD-BEARING SOMEWHERE ELSE, which is worth knowing
 * before anyone simplifies it. pending_object_deletions (0036) is keyed on the
 * storage path alone, so a queued deletion and a later upload that reused the
 * same key would be the same row — and the sweep would remove an object that a
 * live media_files row legitimately claims. Reuse currently needs the same
 * member, the same millisecond, the same nonce and the same filename, so it does
 * not happen; but it does not happen because of this line, not because the queue
 * defends against it. A move to a deterministic key — a content hash, a
 * per-member counter, the bare filename — makes that race real, silently.
 */
export function mediaObjectPath(input: {
  memberId: string
  fileName: string
  now?: number
  nonce?: string
}): string {
  return objectPath({ ...input, prefix: 'media' })
}

/**
 * The same key, under `resources/` instead of `media/`.
 *
 * 자료실 files are media_files rows with a null folder_id, so the row shape does
 * not distinguish them — the object prefix does, and it is the only thing that
 * makes a bucket listing readable. The legacy app draws the same line
 * (index.html:2762 uploads with prefix 'resources', :2749 with 'media').
 */
export function resourceObjectPath(input: {
  memberId: string
  fileName: string
  now?: number
  nonce?: string
}): string {
  return objectPath({ ...input, prefix: 'resources' })
}

/**
 * The same key again, under `chat/`.
 *
 * A chat attachment is not a media library file and must not appear in one: the
 * prefix is what 미디어 and 자료실 read to decide what to list, so filing a
 * direct-message photo under `media/` would put it on a screen its sender never
 * chose to post to.
 *
 * THE PREFIX IS NOT WHAT KEEPS IT PRIVATE. team_file_is_readable is SECURITY
 * INVOKER over messages_read, and that is the whole of the boundary — only the
 * two participants of a dm can read the row that claims this path, so only they
 * can read the object. `chat/` is filing. 0047 says the same thing in the
 * database, in the place somebody reasoning about access will actually look.
 */
export function chatObjectPath(input: {
  memberId: string
  fileName: string
  now?: number
  nonce?: string
}): string {
  return objectPath({ ...input, prefix: 'chat' })
}

function objectPath(input: {
  memberId: string
  fileName: string
  prefix: 'media' | 'resources' | 'chat'
  now?: number
  nonce?: string
}): string {
  const millis = input.now ?? Date.now()
  const nonce = input.nonce ?? Math.random().toString(36).slice(2, 8)
  return `${input.memberId}/${input.prefix}/${millis}_${nonce}_${safeObjectName(input.fileName)}`
}
