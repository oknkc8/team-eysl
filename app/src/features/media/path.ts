/**
 * Naming for objects in the team-files bucket.
 *
 * The first path segment is the uploader's member id, and that is load-bearing
 * rather than tidy: team_files_insert (0009) compares
 * `(storage.foldername(name))[1]` against current_member_id(), so a path that
 * does not start with the caller's own id is refused by the database.
 */

// ASCII ONLY, and this used to keep 가-힣.
//
// The old rule mirrored the legacy sanitizer (index.html:2731) and kept Hangul
// deliberately, so a Korean filename stayed readable instead of flattening into
// a row of underscores. That goal was right. Pursuing it IN THE KEY was not:
// Supabase Storage validates object keys against a restricted character set and
// answers 400 InvalidKey for anything outside it. MEASURED, one variable changed:
//
//     훈련일지.txt        ->  400  {"error":"InvalidKey", …}
//     training-log.txt   ->  200  {"Key":"team-files/…/training-log.txt", …}
//
// So EVERY upload was broken for a Korean filename — media, 자료실, notice
// attachments, 결과지, chat — which in this club is the ordinary case rather than
// the edge one. It survived every gate because nothing in the repository sends
// bytes to storage: the bucket held zero objects, so five features were broken
// identically while typecheck, the unit suite and the browser suite all stayed
// green.
//
// THE READABLE NAME IS NOT LOST, it moved to where it belongs. Every claim table
// carries the original: notice_attachments.file_name, media_files.file_name,
// record_uploads.file_name, and messages.attachment_name (0047). The key is an
// identifier and the name is data; they were the same string, and that is what
// made a display concern into an upload failure.
const UNSAFE = /[^A-Za-z0-9\-_]+/g

/**
 * An ASCII key fragment for this file name.
 *
 * The stem and the extension are sanitized SEPARATELY, which is not fussiness.
 * Treating the whole string at once produces keys that read as something else:
 * `훈련_영상.mp4` collapses to `.mp4`, which looks like a dotfile with no name,
 * and `훈련영상-2026.mp4` to `-2026.mp4`, which looks like a flag. Splitting on
 * the last dot keeps the extension — the part that still tells a person, and the
 * storage service, what kind of file this is — and lets the stem fall back to a
 * word when nothing of it survives.
 */
export function safeObjectName(fileName: string | null | undefined): string {
  const raw = (fileName ?? '').trim()
  const dot = raw.lastIndexOf('.')
  // A leading dot is not an extension separator: `.gitignore` is all stem.
  const hasExt = dot > 0 && dot < raw.length - 1
  const stem = clean(hasExt ? raw.slice(0, dot) : raw)
  const ext = hasExt ? clean(raw.slice(dot + 1)) : ''

  // `file` rather than an empty stem, and it is reached often now: a wholly
  // Korean name leaves nothing behind at all.
  const named = /[A-Za-z0-9]/.test(stem) ? stem : 'file'
  return ext === '' ? named : `${named}.${ext}`
}

/** Unsafe runs to one underscore, then trim the separators off both ends. */
function clean(part: string): string {
  return part.replace(UNSAFE, '_').replace(/^[-_]+/, '').replace(/[-_]+$/, '')
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
