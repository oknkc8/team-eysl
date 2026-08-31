import { describe, expect, it } from 'vitest'

import { uploadAttachmentObjects, type AttachmentUploader, type SavedAttachment } from './api'

function target(id: string, file_name: string): SavedAttachment {
  return {
    id,
    storage_path: `member-1/notices/${id}`,
    file_name,
    mime_type: 'text/plain',
    is_new: true,
  }
}

function file(name: string) {
  return new File(['x'], name, { type: 'text/plain' })
}

/** Records what it was asked to upload, and answers however the test says. */
function uploader(answer: (path: string) => Promise<{ error: unknown }>): AttachmentUploader & {
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    upload(path) {
      calls.push(path)
      return answer(path)
    },
  }
}

const ok = () => Promise.resolve({ error: null })

describe('uploadAttachmentObjects', () => {
  it('reports nothing when every object lands', async () => {
    const up = uploader(ok)
    const failures = await uploadAttachmentObjects(
      up,
      [target('row-a', '\uBB38\uC11C.txt'), target('row-b', '\uC0AC\uC9C4.png')],
      [file('\uBB38\uC11C.txt'), file('\uC0AC\uC9C4.png')],
    )

    expect(failures).toEqual([])
    expect(up.calls).toEqual(['member-1/notices/row-a', 'member-1/notices/row-b'])
  })

  it('reports a storage error as a failure carrying the row id', async () => {
    const up = uploader((path) =>
      path.endsWith('row-b') ? Promise.resolve({ error: { message: 'nope' } }) : ok(),
    )
    const failures = await uploadAttachmentObjects(
      up,
      [target('row-a', '\uBB38\uC11C.txt'), target('row-b', '\uC0AC\uC9C4.png')],
      [file('\uBB38\uC11C.txt'), file('\uC0AC\uC9C4.png')],
    )

    expect(failures.map((f) => f.id)).toEqual(['row-b'])
  })

  // THE REGRESSION. A dropped connection rejects rather than returning { error },
  // and that escaped the loop: saveNotice threw, onSuccess never ran, the form
  // never learned the notice id, and the retry wrote a SECOND notice.
  it('does not throw when the upload rejects, and reports it as a failure', async () => {
    const up = uploader(() => Promise.reject(new Error('network down')))

    const failures = await uploadAttachmentObjects(
      up,
      [target('row-a', '\uBB38\uC11C.txt')],
      [file('\uBB38\uC11C.txt')],
    )

    expect(failures.map((f) => f.id)).toEqual(['row-a'])
  })

  it('keeps going after a rejection so a later file still gets its chance', async () => {
    const up = uploader((path) =>
      path.endsWith('row-a') ? Promise.reject(new Error('network down')) : ok(),
    )
    const failures = await uploadAttachmentObjects(
      up,
      [target('row-a', '\uBB38\uC11C.txt'), target('row-b', '\uC0AC\uC9C4.png')],
      [file('\uBB38\uC11C.txt'), file('\uC0AC\uC9C4.png')],
    )

    // Both were attempted, and only the first is reported.
    expect(up.calls).toHaveLength(2)
    expect(failures.map((f) => f.id)).toEqual(['row-a'])
  })

  it('returns the File itself so the caller can resend it', async () => {
    const sent = file('\uC0AC\uC9C4.png')
    const up = uploader(() => Promise.reject(new Error('network down')))

    const failures = await uploadAttachmentObjects(up, [target('row-a', '\uC0AC\uC9C4.png')], [sent])

    expect(failures[0]?.file).toBe(sent)
  })

  it('uploads nothing when there are no new rows', async () => {
    const up = uploader(ok)
    expect(await uploadAttachmentObjects(up, [], [])).toEqual([])
    expect(up.calls).toEqual([])
  })
})
