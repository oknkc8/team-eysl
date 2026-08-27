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
 * The same key again, under `records/` — a 결과지, the meet sheet the record
 * importer read.
 *
 * A third library rather than a third naming scheme, and 0043 says why: one
 * bucket with two conventions in it buys nothing, and the uniqueness the
 * paragraph above calls load-bearing is exactly what a 결과지 needs too.
 *
 * The library is the only thing separating these objects from 자료실 files —
 * `record_uploads` rows and `media_files` rows both name a path and nothing in
 * the row shape distinguishes them. `team_file_library_allows_me` (0043) reads
 * this prefix to decide that a 결과지 needs `can_manage_records()`, so the
 * prefix is an authorization input, not a label.
 */
export function recordSheetObjectPath(input: {
  memberId: string
  fileName: string
  now?: number
  nonce?: string
}): string {
  return objectPath({ ...input, prefix: 'records' })
}

function objectPath(input: {
  memberId: string
  fileName: string
  prefix: 'media' | 'resources' | 'records'
  now?: number
  nonce?: string
}): string {
  const millis = input.now ?? Date.now()
  const nonce = input.nonce ?? Math.random().toString(36).slice(2, 8)
  return `${input.memberId}/${input.prefix}/${millis}_${nonce}_${safeObjectName(input.fileName)}`
}
