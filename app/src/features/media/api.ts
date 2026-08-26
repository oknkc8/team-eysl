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
  /** Who may rename or delete it — media_folders_update is owner-only (0021). */
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
 *
 * **Row first, object second**, and that order is now enforced rather than
 * chosen: team_files_insert (0021) admits an object only where a media_files row
 * already claims that exact path. It used to be the other way round, which left
 * a window where the bytes were in the bucket and no row pointed at them —
 * nothing in this app lists a bucket, so such an object was invisible, and an
 * invisible object still costs the quota somebody pays for.
 *
 * The remaining failure is the mirror image and a better one: a row whose object
 * never arrived. That shows up as a broken tile the uploader can see and delete,
 * and the cleanup below removes it anyway.
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
      failed.push(file)
      continue
    }

    const upload = await supabase.storage.from(MEDIA_BUCKET).upload(storagePath, file, {
      // Never overwrite. mediaObjectPath() already makes a collision unlikely,
      // and on the off chance of one, failing is the right answer — the other
      // person's file is not ours to replace.
      upsert: false,
      contentType: mimeType,
    })

    if (upload.error) {
      // Take the claim back so the path is free and no tile points at nothing.
      // Best effort: if this also fails the file is still reported as failed,
      // which is the honest outcome either way, and the row is the uploader's
      // own so they can remove it from the screen.
      await supabase.from('media_files').delete().eq('id', row.data.id)
      failed.push(file)
      continue
    }

    uploaded.push(row.data)
  }

  return { uploaded, failed }
}

// -------------------------------------------------------- rename and delete
// Owner only — not owner-or-staff. That is the president's rule, not ours:
// canManageMediaOwner (upstream:2930) reads `ownerId === currentUser.memberId`,
// where the frozen legacy copy still reads `isAdminUser() || ownerId === ...`
// (index.html:2731). He took the admin bypass out; we followed in 0021, and
// media_folders_update / media_files_update / _delete now read
// `= current_member_id()` with no second arm. The screens hide the controls for
// anybody else, which is tidiness — a member who called these directly would
// match zero rows.
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
 * says so.
 *
 * The number means something different since 0036, and better. It used to count
 * objects lost for good: the row was gone, and with it the only thing that made
 * the object visible, so nothing could ever remove it. Now every one of these is
 * a row in pending_object_deletions, and any session that can act on it finishes
 * the job on its next sweep. So this counts work outstanding, not damage done.
 */
export type DeleteOutcome = {
  /** Objects still queued for removal. Rows are gone either way. */
  orphanedObjects: number
}

/**
 * Delete one file: the row first, then its object.
 *
 * Row-first stays, and 0036 is what makes it safe. The row was the only thing
 * granting anybody sight of the object — team_files_read (0029) admits an object
 * only where a row claims its path — so deleting it first made the object
 * invisible, and an invisible object cannot be deleted either: storage-api
 * removes with `delete ... returning *`, and a DELETE that reads columns has the
 * SELECT policy applied on top of the DELETE policy. The call answered 200 with
 * an empty array, having removed nothing, every single time.
 *
 * An AFTER DELETE trigger now queues the path before the row is gone, and the
 * queue entry is itself a claim, so the object stays reachable to whoever can
 * remove it. Sweeping is a separate step precisely so an interrupted delete is
 * finished later instead of being lost.
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

  return { orphanedObjects: await sweepPaths([input.storagePath]) }
}

/**
 * Delete a folder, and with it every file inside.
 *
 * One RPC rather than the three requests this used to be — list the paths,
 * delete the folder row and let the cascade take the file rows, delete the
 * listed objects. A file uploaded between the first and the third lost its row
 * to the cascade and kept its object, and the count reported back was still 0
 * because the caller had never seen it. delete_media_folder_v1 (0021) holds the
 * folder row with FOR UPDATE, which conflicts with the FOR KEY SHARE an
 * inserting file takes, so no file can appear in that window; the paths it
 * returns are all of them.
 *
 * The objects still have to be swept from here, and some of them may refuse:
 * team_files_delete is per object by path prefix, so a folder owner who is not
 * staff can cascade away somebody else's row and still be told no about their
 * object. That is what the returned count measures.
 */
export async function deleteFolder(folderId: string): Promise<DeleteOutcome> {
  const { data, error } = await supabase.rpc('delete_media_folder_v1', {
    p_folder_id: folderId,
  })
  // The RPC raises rather than matching zero rows, so unlike the mutations above
  // there is nothing to inspect afterwards — 42501 arrives here as an error.
  if (error) throw new Error('폴더를 삭제할 권한이 없습니다')

  return { orphanedObjects: await sweepPaths(data ?? []) }
}

// ------------------------------------------------------------------- sweeping

/**
 * How many queued objects one sweep will attempt.
 *
 * Bounded because the queue is drained on a screen somebody is waiting to see,
 * and because remove() takes the whole batch in one request — a backlog should
 * cost several quick sweeps rather than one slow screen.
 */
const SWEEP_BATCH = 50

/**
 * Finish every queued deletion this session is allowed to finish.
 *
 * The queue is drained by whoever can act on it: the member whose prefix the
 * object sits under, or any staff member — the same predicate team_files_delete
 * uses, because it is the same question. There is no server-side sweeper and
 * 0036 explains at length why there cannot be one — a pg_cron job can delete the
 * storage.objects row but not the bytes behind it, and Supabase installs a
 * trigger that refuses the attempt for exactly that reason.
 *
 * Never throws, and that is safe here in a way it would not be elsewhere in this
 * codebase. A swallowed query error normally hides behind a spinner that spins
 * forever; this renders nothing at all, so there is no screen for it to wedge,
 * and housekeeping that could break 미디어 for everyone would be a worse bug
 * than the one it cleans up after. What it returns is how many it could not
 * finish, so a caller that wants to say something has the number.
 */
export async function sweepPendingObjectDeletions(): Promise<number> {
  const { data, error } = await supabase
    .from('pending_object_deletions')
    .select('storage_path')
    .order('requested_at', { ascending: true })
    .limit(SWEEP_BATCH)
  if (error) return 0

  return sweepPaths((data ?? []).map((row) => row.storage_path))
}

/**
 * Remove these objects and clear the queue entries that named them.
 *
 * Returns how many are still outstanding. Never throws: by the time this runs
 * the rows are already gone, so failing here would report a completed delete as
 * an error and invite a retry that has nothing left to delete.
 *
 * The queue entry is cleared only for a path confirmed gone from the bucket,
 * never merely because remove() was called. Clearing early is the one move that
 * would recreate the original defect — the entry is the object's last claim, and
 * dropping it while the object stands is how it becomes unreachable.
 */
async function sweepPaths(paths: string[]): Promise<number> {
  if (paths.length === 0) return 0

  const gone = await removeObjects(paths)
  if (gone.length > 0) {
    // Best effort, like everything after the row is gone. A failure here leaves
    // an entry for an object that no longer exists, which the next sweep
    // resolves through confirmAbsent rather than by deleting anything twice.
    await supabase.from('pending_object_deletions').delete().in('storage_path', gone)
  }
  return paths.length - gone.length
}

/**
 * The paths that are no longer in the bucket, whether this call removed them or
 * they were already absent.
 *
 * The second half is not defensive padding. An upload that fails after its row
 * lands makes uploadMediaFiles delete that row, which queues a path whose object
 * never arrived; and remove() answers `[]` for a path that is not there just as
 * it does for one it was refused. Without an existence check those two are
 * indistinguishable and the first kind of entry could never be cleared — the
 * queue would fill with paths naming nothing.
 */
async function removeObjects(paths: string[]): Promise<string[]> {
  try {
    const { data } = await supabase.storage.from(MEDIA_BUCKET).remove(paths)
    const removed = (data ?? []).map((object) => object.name)

    const unresolved = paths.filter((path) => !removed.includes(path))
    if (unresolved.length === 0) return removed

    return [...removed, ...(await confirmAbsent(unresolved))]
  } catch {
    return []
  }
}

/**
 * Which of these paths the bucket does not hold.
 *
 * Only ever asked about the residue of a remove(), which is normally empty, so
 * the per-path request costs nothing on the ordinary delete. A listing that
 * errors — including the refusal a member gets for somebody else's prefix —
 * counts as "still there", because the entry must survive anything short of
 * proof that the object is gone.
 */
async function confirmAbsent(paths: string[]): Promise<string[]> {
  const absent: string[] = []
  for (const path of paths) {
    const cut = path.lastIndexOf('/')
    // A path with no separator cannot be one of ours — 0021 pins the shape to
    // `<member id>/(media|resources)/<name>` — and asking about it would list
    // the bucket root. Leave it queued for somebody to look at.
    if (cut < 0) continue
    const folder = path.slice(0, cut)
    const fileName = path.slice(cut + 1)

    const { data, error } = await supabase.storage
      .from(MEDIA_BUCKET)
      .list(folder, { limit: 100, search: fileName })
    if (error) continue
    if (!(data ?? []).some((object) => object.name === fileName)) absent.push(path)
  }
  return absent
}
