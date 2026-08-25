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

function objectPath(input: {
  memberId: string
  fileName: string
  prefix: 'media' | 'resources'
  now?: number
  nonce?: string
}): string {
  const millis = input.now ?? Date.now()
  const nonce = input.nonce ?? Math.random().toString(36).slice(2, 8)
  return `${input.memberId}/${input.prefix}/${millis}_${nonce}_${safeObjectName(input.fileName)}`
}
