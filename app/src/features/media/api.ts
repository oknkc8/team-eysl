import { supabase } from '../../lib/supabase'
import { mediaObjectPath } from './path'

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

/** Every folder, newest first, with how many files it holds. */
export async function listFolders(): Promise<MediaFolder[]> {
  // The count comes back as an embedded aggregate rather than one query per
  // folder, the same shape notices uses for its comment and attachment counts.
  const { data, error } = await supabase
    .from('media_folders')
    .select('id, name, created_at, media_files(count)')
    .order('created_at', { ascending: false })
  if (error) throw error

  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    created_at: row.created_at,
    file_count: row.media_files[0]?.count ?? 0,
  }))
}

export async function getFolder(folderId: string): Promise<MediaFolder> {
  const { data, error } = await supabase
    .from('media_folders')
    .select('id, name, created_at, media_files(count)')
    .eq('id', folderId)
    .single()
  if (error) throw error

  return {
    id: data.id,
    name: data.name,
    created_at: data.created_at,
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
    .select('id, name, created_at')
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
 * Put files in a folder.
 *
 * Sequential, and each file independent: a selection of twenty photos where one
 * fails should keep the nineteen. The failures come back as the original File
 * objects so a retry re-sends only them — retrying the whole selection would
 * upload a duplicate of everything that already worked.
 */
export async function uploadMediaFiles(input: {
  folderId: string
  files: File[]
}): Promise<UploadOutcome> {
  const memberId = await getMyMemberId()
  const uploaded: MediaFile[] = []
  const failed: File[] = []

  for (const file of input.files) {
    const storagePath = mediaObjectPath({ memberId, fileName: file.name })
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
