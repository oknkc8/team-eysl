/**
 * Naming for objects in the profile-images bucket.
 *
 * Two segments, and the shape is load-bearing rather than tidy:
 * `is_my_avatar_object_path` (0027) matches `^<my member id>/[^/]+$` and both
 * the storage policies and `set_my_avatar_path_v1` consult it, so a key with a
 * third segment or somebody else's id is refused twice over — once by the
 * bucket and once by the RPC that records it.
 *
 * Deliberately not media/path.ts. That module builds
 * `<memberId>/(media|resources)/<name>` for the team-files bucket, which
 * `is_my_media_object_path` (0021) requires to have exactly three segments.
 * Feeding an avatar through it would produce a key this bucket rejects, and
 * feeding a media file through this one would produce a key that one rejects.
 * The two shapes differ because the two policies do.
 */

// The president's own key (upstream:3609): a fixed prefix, the upload time and
// the extension. Not the original file name — an avatar is one image per member
// and the name carries nothing a reader needs, while a Korean or emoji filename
// only adds ways for the key to need escaping.
const DEFAULT_EXTENSION = 'jpg'

/**
 * The extension, reduced to something safe to put in an object key.
 *
 * Lowercased and stripped of everything but letters and digits, matching his
 * `replace(/[^a-z0-9]/g,'')`. A file with no usable extension gets 'jpg' rather
 * than a key ending in a bare dot.
 */
export function safeExtension(fileName: string | null | undefined): string {
  const parts = (fileName ?? '').split('.')
  // A name with no dot has no extension to take — `split` returns one element,
  // and using it would turn "photo" into the extension "photo".
  if (parts.length < 2) return DEFAULT_EXTENSION

  const cleaned = (parts[parts.length - 1] ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  return cleaned === '' ? DEFAULT_EXTENSION : cleaned
}

/**
 * `<memberId>/avatar-<millis>.<ext>`.
 *
 * The timestamp is what makes replacing a photo safe: the upload is issued with
 * upsert:false against a key nothing holds yet, so a failed RPC afterwards
 * leaves the old object still standing rather than a half-replaced one. `now`
 * is injectable so a test can assert the whole string.
 */
export function avatarObjectPath(input: {
  memberId: string
  fileName: string
  now?: number
}): string {
  const stamp = input.now ?? Date.now()
  return `${input.memberId}/avatar-${stamp}.${safeExtension(input.fileName)}`
}
