/**
 * The claim rule for 대회 첨부파일, in the one place a test can reach it.
 *
 * This module imports nothing. `raceAttachmentApi.ts` loads the Supabase client
 * at import time, and everything below has to be exercisable without one — the
 * same split `kinds.ts` and `raceEntry.ts` already make in this folder.
 *
 * (The api module is `raceAttachmentApi.ts` rather than the `raceAttachments.ts`
 * that would have matched `notices/api.ts`'s naming, because macOS compares file
 * names case-insensitively and tsc refuses a program holding both it and
 * `RaceAttachments.tsx`. The error names casing rather than collision, so it is
 * worth one line here.)
 *
 * ---------------------------------------------------------------------------
 * WHAT THE RULE IS
 *
 * `team-files` may not hold bytes that no row points at. 0021 built that as a
 * storage policy — team_files_insert asks media_object_is_claimed(name) — and
 * 0054 taught the predicate about race_attachments. The database therefore
 * refuses an unclaimed object on its own, and nothing here is load-bearing for
 * an attacker.
 *
 * What this file defends is the ORDER, which is a correctness problem rather
 * than a security one. add_race_attachment_v1 creates the row and derives the
 * key; the browser then puts the bytes at exactly that key. If the browser ever
 * uploads before, instead of, or beside a claim — because the RPC answered with
 * something unexpected and the code carried on — the request is refused by the
 * storage service and the failure arrives as an opaque policy denial, several
 * layers from the mistake. Refusing here says what actually went wrong.
 *
 * THE SECOND HALF IS THAT THE CLIENT CONTRIBUTES NOTHING TO THE KEY. 0044 is
 * what happens when it does: record_uploads let the client name the path, and
 * one INSERT turned a path the caller could not read into one they could. There
 * is no path parameter on the RPC, so this file's job is only to make sure the
 * string the server returned is the string that gets uploaded to — not one
 * derived from the file's own name, which is where `../`, a null byte and a
 * name that is entirely dots would otherwise have to be handled.
 */

/**
 * Upstream's cap (race-attachment-v123.js), and the same number
 * add_race_attachment_v1 raises on.
 *
 * The screen reads it to stop offering the picker, which is a courtesy. The
 * enforcement is in the database: race_attachments has no INSERT policy and no
 * INSERT grant, so the RPC is the only door and its count is taken under a lock
 * on the race row.
 */
export const MAX_RACE_ATTACHMENTS = 8

/** What add_race_attachment_v1 returns, once it has been checked. */
export type RaceAttachmentClaim = {
  id: string
  storage_path: string
  file_name: string
  mime_type: string
}

/**
 * The slice of the storage client this needs, and nothing more.
 *
 * Narrow on purpose, for the reason notices/api.ts gives about its own
 * uploader: a test satisfies it with an object literal, so the upload step can
 * be exercised without a mocking framework — of which this repository has none.
 */
export type ObjectUploader = {
  upload(
    path: string,
    file: Blob,
    options: { contentType: string; upsert: boolean },
  ): Promise<{ error: unknown }>
}

export const NO_CLAIM_MESSAGE = '첨부 정보를 받지 못해 파일을 올리지 않았습니다.'

/**
 * Read the RPC's reply as a claim, or refuse.
 *
 * The reply is `jsonb`, which reaches TypeScript as `Json` — an unknown shape
 * as far as the compiler is concerned — so this is where it becomes a claim or
 * stops being anything.
 *
 * BOTH `id` AND `storage_path` ARE REQUIRED, and half a claim is not one. An
 * id with no path is a row whose object can never be uploaded; a path with no
 * id is a key the screen could not later remove, because remove_race_attachment_v1
 * takes the row id. Either way the next step is wrong, and the useful moment to
 * say so is here rather than three layers down.
 */
export function toRaceAttachmentClaim(reply: unknown): RaceAttachmentClaim {
  const row = (reply ?? {}) as Record<string, unknown>
  const id = typeof row.id === 'string' ? row.id : ''
  const storagePath = typeof row.storage_path === 'string' ? row.storage_path : ''

  // THE CLAIM RULE. Deleting these two lines does not produce a type error and
  // does not produce a crash: it produces an upload to the empty string, which
  // is bytes sent for a path no row claims. raceAttachmentUpload.test.ts fails
  // on exactly that.
  if (id === '' || storagePath === '') {
    throw new Error(NO_CLAIM_MESSAGE)
  }

  return {
    id,
    storage_path: storagePath,
    file_name: typeof row.file_name === 'string' ? row.file_name : '파일',
    mime_type:
      typeof row.mime_type === 'string' && row.mime_type !== ''
        ? row.mime_type
        : 'application/octet-stream',
  }
}

/** A claim that exists, and whether its bytes arrived. */
export type RaceAttachmentUpload = {
  claim: RaceAttachmentClaim
  uploaded: boolean
}

/**
 * Put the object at the key the server named.
 *
 * ONCE THE RPC HAS SUCCEEDED THE ROW EXISTS, so a storage failure is reported
 * and not thrown — notices/api.ts learned that the expensive way, where a
 * rejected upload escaped the loop, the caller's onSuccess never ran, the form
 * never learned the id, and the retry wrote a second notice. The row here is
 * already committed; throwing would only hide it from the screen that has to
 * offer the retry.
 *
 * A refused CLAIM is different and does throw: nothing has been created, so
 * there is nothing to tell the screen about.
 *
 * The failure is recoverable without re-creating anything: the row goes on
 * claiming the path, so team_files_update accepts a re-upload to the same key.
 */
export async function uploadRaceAttachmentObject(
  uploader: ObjectUploader,
  reply: unknown,
  file: Blob,
): Promise<RaceAttachmentUpload> {
  const claim = toRaceAttachmentClaim(reply)

  try {
    // claim.storage_path verbatim, and claim.mime_type rather than file.type:
    // the row is what the bucket will be asked about later, so the object has
    // to match the row rather than the picker.
    const result = await uploader.upload(claim.storage_path, file, {
      contentType: claim.mime_type,
      upsert: true,
    })
    return { claim, uploaded: !result.error }
  } catch {
    // A rejection is a failure like any other and must become one HERE.
    return { claim, uploaded: false }
  }
}
