import { describe, expect, it } from 'vitest'
import {
  MAX_RACE_ATTACHMENTS,
  NO_CLAIM_MESSAGE,
  toRaceAttachmentClaim,
  uploadRaceAttachmentObject,
  type ObjectUploader,
} from './raceAttachmentUpload'

/**
 * A storage client that records rather than uploads.
 *
 * `calls` is the assertion that matters throughout this file. Every rule here
 * is about whether bytes were sent and to which key, and a test that only
 * checks the return value cannot tell "refused" from "uploaded to the wrong
 * place and then reported an error".
 */
function recordingUploader(result: { error: unknown } = { error: null }): ObjectUploader & {
  calls: { path: string; contentType: string; upsert: boolean }[]
} {
  const calls: { path: string; contentType: string; upsert: boolean }[] = []
  return {
    calls,
    async upload(path, _file, options) {
      calls.push({ path, contentType: options.contentType, upsert: options.upsert })
      return result
    },
  }
}

const FILE = new Blob(['x'])

const CLAIM = {
  id: '2f1a0c5e-0000-4000-8000-000000000001',
  storage_path: '9c3d4e5f-0000-4000-8000-000000000002/races/2f1a0c5e-0000-4000-8000-000000000001',
  file_name: '2026 시도대항전 요강.pdf',
  mime_type: 'application/pdf',
}

describe('the claim rule', () => {
  // THE MUTATION THIS EXISTS FOR: delete the `if (id === '' || storagePath ===
  // '')` throw in toRaceAttachmentClaim. Without it the reply below yields a
  // claim whose path is the empty string, uploader.upload('') is called, and
  // this test fails on calls.length — which is the real failure it guards,
  // because bytes sent for a path no row claims is exactly what 0021's claim
  // gate exists to prevent.
  it('sends no bytes when the reply carries no storage path', async () => {
    const uploader = recordingUploader()

    await expect(uploadRaceAttachmentObject(uploader, { id: CLAIM.id }, FILE)).rejects.toThrow(
      NO_CLAIM_MESSAGE,
    )

    expect(uploader.calls).toEqual([])
  })

  // Half a claim is not a claim. A path with no id is a key the screen could
  // never remove afterwards, because remove_race_attachment_v1 takes the row id.
  it('sends no bytes when the reply carries no id', async () => {
    const uploader = recordingUploader()

    await expect(
      uploadRaceAttachmentObject(uploader, { storage_path: CLAIM.storage_path }, FILE),
    ).rejects.toThrow(NO_CLAIM_MESSAGE)

    expect(uploader.calls).toEqual([])
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty object', {}],
    ['a string', 'ok'],
    ['empty strings in both fields', { id: '', storage_path: '' }],
    ['a non-string path', { id: CLAIM.id, storage_path: 42 }],
  ])('sends no bytes when the reply is %s', async (_label, reply) => {
    const uploader = recordingUploader()

    await expect(uploadRaceAttachmentObject(uploader, reply, FILE)).rejects.toThrow(
      NO_CLAIM_MESSAGE,
    )

    expect(uploader.calls).toEqual([])
  })
})

describe('the key comes from the server and nowhere else', () => {
  it('uploads to exactly the path the RPC returned', async () => {
    const uploader = recordingUploader()

    const outcome = await uploadRaceAttachmentObject(uploader, CLAIM, FILE)

    expect(uploader.calls).toEqual([
      { path: CLAIM.storage_path, contentType: 'application/pdf', upsert: true },
    ])
    expect(outcome).toEqual({ claim: CLAIM, uploaded: true })
  })

  // The file name never reaches the key — that is the whole reason
  // add_race_attachment_v1 takes no path parameter, and the reason no
  // sanitising rule here has to be right. A name that would be hostile in a
  // path is carried in file_name for display and changes nothing about where
  // the bytes go.
  it('ignores a hostile file name in the reply', async () => {
    const uploader = recordingUploader()

    await uploadRaceAttachmentObject(
      uploader,
      { ...CLAIM, file_name: '../../../etc/passwd' },
      FILE,
    )

    expect(uploader.calls[0]?.path).toBe(CLAIM.storage_path)
  })

  // A path field the server did not send cannot be substituted for one it did.
  it('does not accept an alternative path field', async () => {
    const uploader = recordingUploader()

    await uploadRaceAttachmentObject(uploader, { ...CLAIM, path: 'somebody-else/races/x' }, FILE)

    expect(uploader.calls[0]?.path).toBe(CLAIM.storage_path)
  })

  // The row is what the bucket is asked about later, so the object's declared
  // type has to match the row rather than the picker.
  it('sends the row mime type, falling back rather than sending an empty one', async () => {
    const uploader = recordingUploader()

    await uploadRaceAttachmentObject(uploader, { ...CLAIM, mime_type: '' }, FILE)

    expect(uploader.calls[0]?.contentType).toBe('application/octet-stream')
  })
})

describe('a storage failure does not discard the row', () => {
  // ONCE THE RPC HAS SUCCEEDED THE ROW EXISTS. Throwing here would hide a
  // committed attachment from the screen that has to offer the retry — the
  // defect notices/api.ts records, where a rejected upload escaped and the
  // retry wrote a second notice.
  it('reports a refused upload instead of throwing', async () => {
    const uploader = recordingUploader({ error: { message: 'boom' } })

    const outcome = await uploadRaceAttachmentObject(uploader, CLAIM, FILE)

    expect(outcome).toEqual({ claim: CLAIM, uploaded: false })
  })

  it('reports a rejected upload instead of throwing', async () => {
    const uploader: ObjectUploader = {
      async upload() {
        throw new Error('network')
      },
    }

    const outcome = await uploadRaceAttachmentObject(uploader, CLAIM, FILE)

    expect(outcome).toEqual({ claim: CLAIM, uploaded: false })
  })
})

describe('toRaceAttachmentClaim', () => {
  it('fills a missing display name rather than refusing', () => {
    // file_name is display only and never part of the key, so a missing one is
    // a rendering problem and not a reason to reject a row that exists.
    const claim = toRaceAttachmentClaim({ id: CLAIM.id, storage_path: CLAIM.storage_path })

    expect(claim.file_name).toBe('파일')
    expect(claim.mime_type).toBe('application/octet-stream')
  })
})

describe('the cap', () => {
  // Upstream's race-attachment-v123.js number. The screen reads it to stop
  // offering the picker; add_race_attachment_v1 raises on the same value under
  // a lock, and that is where it is actually enforced.
  it('is eight', () => {
    expect(MAX_RACE_ATTACHMENTS).toBe(8)
  })
})
