import { supabase } from '../../lib/supabase'
import { mediaObjectPath, resourceObjectPath } from './path'

// Rows store a path inside this bucket, never a URL, so the bucket can be
// renamed or its policies changed without rewriting rows. The bucket and its
// policies are created in 0009 — neither existed before, which is why every
// signed URL on this screen would previously have failed.
const MEDIA_BUCKET = 'team-files'

// Longer than the 60s notices signs an attachment for. A photo grid resolves in
// one round trip, but a video is fetched in ranges across the whole time
// somebody watches it, and a URL that lapses mid-playback stalls the player.
const MEDIA_URL_TTL_SECONDS = 3600

export type MediaFolder = {
  id: string
  name: string
  created_at: string
  file_count: number
  /** Who may rename or delete it — media_folders_update/delete is owner-or-staff. */
  created_by: string
}

export type MediaFile = {
  id: string
  folder_id: string | null
  file_name: string
  mime_type: string
  storage_path: string
  uploader_id: string
  created_at: string
}

const FILE_COLUMNS = 'id, folder_id, file_name, mime_type, storage_path, uploader_id, created_at'

// ------------------------------------------------------------------- reads

const FOLDER_COLUMNS = 'id, name, created_at, created_by, media_files(count)'

/** Every folder, newest first, with how many files it holds. */
export async function listFolders(): Promise<MediaFolder[]> {
  // The count comes back as an embedded aggregate rather than one query per
  // folder, the same shape notices uses for its comment and attachment counts.
  const { data, error } = await supabase
    .from('media_folders')
    .select(FOLDER_COLUMNS)
    .order('created_at', { ascending: false })
  if (error) throw error

  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    created_at: row.created_at,
    created_by: row.created_by,
    file_count: row.media_files[0]?.count ?? 0,
  }))
}

export async function getFolder(folderId: string): Promise<MediaFolder> {
  const { data, error } = await supabase
    .from('media_folders')
    .select(FOLDER_COLUMNS)
    .eq('id', folderId)
    .single()
  if (error) throw error

  return {
    id: data.id,
    name: data.name,
    created_at: data.created_at,
    created_by: data.created_by,
    file_count: data.media_files[0]?.count ?? 0,
  }
}

export async function listFolderFiles(folderId: string): Promise<MediaFile[]> {
  const { data, error } = await supabase
    .from('media_files')
    .select(FILE_COLUMNS)
    .eq('folder_id', folderId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

/**
 * 자료실: the files that belong to no folder.
 *
 * `folder_id is null` is the whole definition — 0004:109-110 says so in the
 * column comment, and the legacy app splits the same list the same way
 * (index.html:1246, `resourceFiles = fileMap.filter(f => !f.folderId)`). There
 * is no separate table, so a file moved out of a folder would land here, and a
 * folder deletion takes its files with it rather than dropping them in.
 */
export async function listResourceFiles(): Promise<MediaFile[]> {
  const { data, error } = await supabase
    .from('media_files')
    .select(FILE_COLUMNS)
    .is('folder_id', null)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

/**
 * A signed URL for one stored object.
 *
 * Deliberately one file at a time rather than a batch for the whole folder: a
 * tile that owns its own request is a tile that can show its own spinner, and a
 * slow video then delays nothing but itself.
 */
export async function getMediaUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from(MEDIA_BUCKET)
    .createSignedUrl(storagePath, MEDIA_URL_TTL_SECONDS)
  if (error) throw error
  return data.signedUrl
}

// ------------------------------------------------------------------ writes

// Asked of the server rather than threaded down from the session, as in every
// other module here. It is also what the object path must start with, so
// getting it wrong fails the storage policy rather than silently mis-filing.
async function getMyMemberId(): Promise<string> {
  const { data, error } = await supabase.rpc('current_member_id')
  if (error) throw error
  if (!data) throw new Error('승인된 회원이 아닙니다')
  return data
}

export async function createFolder(name: string): Promise<MediaFolder> {
  const memberId = await getMyMemberId()

  const { data, error } = await supabase
    .from('media_folders')
    .insert({ name: name.trim(), created_by: memberId })
    .select('id, name, created_at, created_by')
    .single()
  if (error) throw error

  return { ...data, file_count: 0 }
}

export type UploadOutcome = {
  uploaded: MediaFile[]
  /** The files that did not land, so the caller can retry exactly those. */
  failed: File[]
}

/**
 * Put files in a folder, or in 자료실 when folderId is null.
 *
 * Sequential, and each file independent: a selection of twenty photos where one
 * fails should keep the nineteen. The failures come back as the original File
 * objects so a retry re-sends only them — retrying the whole selection would
 * upload a duplicate of everything that already worked.
 *
 * A null folderId is not a missing value, it is the 자료실 (0004:109-110). It
 * also picks the object prefix, so the two libraries stay distinguishable in a
 * bucket listing even though their rows differ only by that null.
 */
export async function uploadMediaFiles(input: {
  folderId: string | null
  files: File[]
}): Promise<UploadOutcome> {
  const memberId = await getMyMemberId()
  const uploaded: MediaFile[] = []
  const failed: File[] = []

  for (const file of input.files) {
    const storagePath =
      input.folderId === null
        ? resourceObjectPath({ memberId, fileName: file.name })
        : mediaObjectPath({ memberId, fileName: file.name })
    const mimeType = file.type || 'application/octet-stream'

    const upload = await supabase.storage.from(MEDIA_BUCKET).upload(storagePath, file, {
      // Never overwrite. mediaObjectPath() already makes a collision unlikely,
      // and on the off chance of one, failing is the right answer — the other
      // person's file is not ours to replace.
      upsert: false,
      contentType: mimeType,
    })
    if (upload.error) {
      failed.push(file)
      continue
    }

    const row = await supabase
      .from('media_files')
      .insert({
        folder_id: input.folderId,
        uploader_id: memberId,
        file_name: file.name,
        storage_path: storagePath,
        mime_type: mimeType,
      })
      .select(FILE_COLUMNS)
      .single()

    if (row.error) {
      // The object is in the bucket but no row points at it, and nothing in this
      // app lists a bucket directly — an orphan here would be invisible and
      // unreachable. The cleanup is best effort: if it also fails, the upload is
      // still reported as failed, which is the honest outcome either way.
      await supabase.storage.from(MEDIA_BUCKET).remove([storagePath])
      failed.push(file)
      continue
    }

    uploaded.push(row.data)
  }

  return { uploaded, failed }
}

// -------------------------------------------------------- rename and delete
// Both are owner-or-staff, and RLS is where that holds: media_folders_update /
// _delete and media_files_update / _delete (0004:232-252) each read
// `created_by = current_member_id() or is_staff()`. The screens hide the
// controls for anybody else, which is tidiness — a member who called these
// directly would match zero rows.
//
// Every mutation below therefore checks what came back rather than only the
// error. PostgREST answers a policy-refused UPDATE or DELETE with 200 and an
// empty array, not with an error, so `if (error) throw` alone would report a
// silent no-op as a success. The legacy app learned this the same way
// (index.html:2741, `if (error || !data?.length)`).

export async function renameFolder(input: { folderId: string; name: string }): Promise<void> {
  const { data, error } = await supabase
    .from('media_folders')
    .update({ name: input.name.trim(), updated_at: new Date().toISOString() })
    .eq('id', input.folderId)
    .select('id')
  if (error) throw error
  if ((data ?? []).length === 0) throw new Error('폴더 이름을 바꿀 권한이 없습니다')
}

export async function renameMediaFile(input: { fileId: string; fileName: string }): Promise<void> {
  // Only the display name. storage_path is left alone on purpose: renaming the
  // object would mean copy-then-delete in the bucket, and a failure half way
  // through loses the file to rename it.
  const { data, error } = await supabase
    .from('media_files')
    .update({ file_name: input.fileName.trim() })
    .eq('id', input.fileId)
    .select('id')
  if (error) throw error
  if ((data ?? []).length === 0) throw new Error('파일 이름을 바꿀 권한이 없습니다')
}

/**
 * What a delete left behind in the bucket.
 *
 * Removing a row does not remove the object — they are separate systems, and
 * the storage policy answers separately. So a delete reports how many objects
 * it could not remove instead of pretending the bucket is clean, and the screen
 * says so. An orphan is invisible (nothing in this app lists a bucket) but it
 * still occupies the quota somebody pays for.
 */
export type DeleteOutcome = {
  /** Objects the bucket refused to drop. Rows are gone either way. */
  orphanedObjects: number
}

/**
 * Delete one file: the row first, then its object.
 *
 * Row-first is deliberate. The other order destroys the object and then finds
 * out RLS will not let the row go, leaving a row that points at nothing — a
 * broken tile rather than an invisible orphan. This way the worst case is a
 * bucket object nobody references, which is recoverable and reported.
 */
export async function deleteMediaFile(input: {
  fileId: string
  storagePath: string
}): Promise<DeleteOutcome> {
  const { data, error } = await supabase
    .from('media_files')
    .delete()
    .eq('id', input.fileId)
    .select('id')
  if (error) throw error
  if ((data ?? []).length === 0) throw new Error('파일을 삭제할 권한이 없습니다')

  return { orphanedObjects: await removeObjects([input.storagePath]) }
}

/**
 * Delete a folder, and with it every file inside.
 *
 * media_files.folder_id cascades (0004:110), so the rows go whether or not this
 * caller could have deleted them one by one — a referential action runs as the
 * table owner and RLS does not apply to it. The objects are a different matter:
 * team_files_delete (0009:171-176) is owner-or-staff per object, so a folder
 * owner who is not staff can cascade away somebody else's row and still be
 * refused their object. Hence the paths are collected first and the count of
 * what survived is returned rather than assumed to be zero.
 */
export async function deleteFolder(folderId: string): Promise<DeleteOutcome> {
  // Read before the delete: after the cascade there is nothing left to ask.
  const files = await listFolderFiles(folderId)

  const { data, error } = await supabase
    .from('media_folders')
    .delete()
    .eq('id', folderId)
    .select('id')
  if (error) throw error
  if ((data ?? []).length === 0) throw new Error('폴더를 삭제할 권한이 없습니다')

  return { orphanedObjects: await removeObjects(files.map((file) => file.storage_path)) }
}

/**
 * Best effort removal from the bucket; returns how many objects survived.
 *
 * Never throws. By the time this is called the rows are already gone, so
 * failing here would report a completed delete as an error and invite a retry
 * that has nothing left to delete.
 */
async function removeObjects(paths: string[]): Promise<number> {
  if (paths.length === 0) return 0
  try {
    const { data, error } = await supabase.storage.from(MEDIA_BUCKET).remove(paths)
    if (error) return paths.length
    return paths.length - (data ?? []).length
  } catch {
    return paths.length
  }
}
