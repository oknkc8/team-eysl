import { supabase } from '../../lib/supabase'
import { uploadRaceAttachmentObject, type RaceAttachmentUpload } from './raceAttachmentUpload'

export {
  MAX_RACE_ATTACHMENTS,
  NO_CLAIM_MESSAGE,
  toRaceAttachmentClaim,
  uploadRaceAttachmentObject,
} from './raceAttachmentUpload'
export type { RaceAttachmentClaim, RaceAttachmentUpload } from './raceAttachmentUpload'

// The same bucket every other attachment lives in. 0054 adds `races/` to it as
// a sixth library rather than creating a bucket, because a second bucket would
// need its own copy of four storage policies to say the same thing.
const ATTACHMENT_BUCKET = 'team-files'

export type RaceAttachment = {
  id: string
  file_name: string
  mime_type: string
  storage_path: string
  sort_order: number
}

/**
 * Read straight from the table, with no RPC in front of it.
 *
 * That is a decision and 0054's header argues it: race_attachments must carry a
 * SELECT policy anyway, because team_file_is_readable is SECURITY INVOKER and
 * that policy is what lets a member download the object at all. A list function
 * beside it would be a second statement of "any approved member may see a
 * race's attachments", and two statements of one rule can drift. Same shape as
 * listAttachments() for notice_attachments.
 */
export async function listRaceAttachments(activityId: string): Promise<RaceAttachment[]> {
  const { data, error } = await supabase
    .from('race_attachments')
    .select('id, file_name, mime_type, storage_path, sort_order')
    .eq('activity_id', activityId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw error
  return data ?? []
}

/**
 * Signed on demand and short-lived, so a link copied out of the page stops
 * working quickly. Identical to getAttachmentUrl() for 공지 첨부.
 */
export async function getRaceAttachmentUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from(ATTACHMENT_BUCKET)
    .createSignedUrl(storagePath, 60)
  if (error) throw error
  return data.signedUrl
}

/**
 * Create the row, then put the object at the key the row was given.
 *
 * THE ORDER IS FORCED AND IS NOT A PREFERENCE. team_files_insert requires
 * media_object_is_claimed(name), so the bucket refuses an object no row points
 * at — row first, always. The upload step is in raceAttachmentUpload.ts so a
 * test can reach it without a Supabase client.
 *
 * THE PATH IS NOT AN ARGUMENT. add_race_attachment_v1 takes a file name and a
 * mime type; it derives `<caller's member id>/races/<uuid>` itself and returns
 * it. A caller cannot claim a path under somebody else's member id because
 * there is no parameter in which to say it — which is what 0044 had to close
 * for record_uploads after the fact.
 *
 * An upload that does not land leaves `uploaded: false` and a row that exists.
 * That failure is the visible one on purpose (0040): the staffer sees an
 * attachment that opens to nothing and can remove or replace it, where the
 * other ordering would leave bytes nobody can find.
 */
export async function addRaceAttachment(input: {
  activityId: string
  file: File
}): Promise<RaceAttachmentUpload> {
  const { data, error } = await supabase.rpc('add_race_attachment_v1', {
    p_activity_id: input.activityId,
    p_file_name: input.file.name,
    // A picker can hand over an empty type for an unrecognised extension. The
    // RPC substitutes application/octet-stream; sending '' rather than guessing
    // keeps that decision in one place.
    p_mime_type: input.file.type,
  })
  if (error) throw error

  return uploadRaceAttachmentObject(
    supabase.storage.from(ATTACHMENT_BUCKET),
    data,
    input.file,
  )
}

/**
 * Remove the row. The object follows through the deletion queue.
 *
 * Nothing here touches storage, and that is 0036's design rather than an
 * oversight: the enqueue trigger records the path, and the bytes leave when a
 * session sweeps pending_object_deletions. An interrupted delete is therefore
 * survivable — the queue entry keeps the object reachable to whoever may remove
 * it, instead of leaving debris no session can see.
 *
 * A `races/` path is only sweepable by staff, because team_files_delete asks
 * team_file_library_allows_me and 0054 gates that library on is_staff(). So the
 * bytes go when a staffer next opens 미디어 or 자료실, not when a member does.
 */
export async function removeRaceAttachment(attachmentId: string): Promise<void> {
  const { error } = await supabase.rpc('remove_race_attachment_v1', {
    p_attachment_id: attachmentId,
  })
  if (error) throw error
}
