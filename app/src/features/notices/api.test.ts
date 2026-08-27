import { describe, expect, it } from 'vitest'

import { nextEditorStateAfterSave, type SaveNoticeResult } from './api'

// A notice row is required by the type and irrelevant to every assertion here,
// so it is built once and never inspected.
const notice = {
  id: 'notice-1',
  title: '공지',
  body: '본문',
  created_at: '2026-08-26T00:00:00Z',
  updated_at: '2026-08-26T00:00:00Z',
  created_by: 'member-1',
} as SaveNoticeResult['notice']

function attachment(id: string, file_name: string, is_new = true) {
  return {
    id,
    storage_path: `member-1/notices/${id}`,
    file_name,
    mime_type: 'application/octet-stream',
    is_new,
  }
}

function file(name: string) {
  return new File(['x'], name, { type: 'text/plain' })
}

describe('nextEditorStateAfterSave', () => {
  it('keeps every row when nothing failed', () => {
    const next = nextEditorStateAfterSave({
      notice,
      attachments: [attachment('row-a', '문서.txt'), attachment('row-b', '사진.png')],
      uploadFailures: [],
    })

    expect(next.kept.map((row) => row.id)).toEqual(['row-a', 'row-b'])
    expect(next.files).toEqual([])
    expect(next.failedNames).toEqual([])
  })

  // THE REGRESSION. The previous version kept the failed row and cleared the
  // files, so the retry resent nothing, the RPC handed the broken row back as an
  // ordinary existing attachment, and the screen reported success over an
  // attachment that opens to nothing.
  it('drops a row whose object never arrived and puts its file back on the queue', () => {
    const broken = file('사진.png')
    const next = nextEditorStateAfterSave({
      notice,
      attachments: [attachment('row-a', '문서.txt'), attachment('row-b', '사진.png')],
      uploadFailures: [{ id: 'row-b', file_name: '사진.png', file: broken }],
    })

    // row-b must NOT be kept: leaving it in the keep set is what told the RPC
    // to preserve a row with no object behind it.
    expect(next.kept.map((row) => row.id)).toEqual(['row-a'])
    // and its File must come back, or the retry uploads nothing.
    expect(next.files).toEqual([broken])
    expect(next.failedNames).toEqual(['사진.png'])
  })

  // Two files picked in one go can share a name — the upload loop says so, and
  // it is why the failure list is keyed on the row id rather than the name.
  it('separates two failures that share a file name', () => {
    const first = file('사진.png')
    const second = file('사진.png')
    const next = nextEditorStateAfterSave({
      notice,
      attachments: [
        attachment('row-a', '사진.png'),
        attachment('row-b', '사진.png'),
        attachment('row-c', '문서.txt'),
      ],
      uploadFailures: [{ id: 'row-b', file_name: '사진.png', file: second }],
    })

    // Keyed by name, this would have dropped both rows or neither.
    expect(next.kept.map((row) => row.id)).toEqual(['row-a', 'row-c'])
    expect(next.files).toEqual([second])
    expect(next.files).not.toContain(first)
  })

  it('drops every row when all of them failed', () => {
    const a = file('문서.txt')
    const b = file('사진.png')
    const next = nextEditorStateAfterSave({
      notice,
      attachments: [attachment('row-a', '문서.txt'), attachment('row-b', '사진.png')],
      uploadFailures: [
        { id: 'row-a', file_name: '문서.txt', file: a },
        { id: 'row-b', file_name: '사진.png', file: b },
      ],
    })

    expect(next.kept).toEqual([])
    expect(next.files).toEqual([a, b])
  })

  // An attachment that was already on the notice is not is_new and was never
  // uploaded by this call, so a failure elsewhere must not disturb it.
  it('leaves a pre-existing attachment alone when a new one fails', () => {
    const broken = file('사진.png')
    const next = nextEditorStateAfterSave({
      notice,
      attachments: [attachment('row-old', '기존.pdf', false), attachment('row-b', '사진.png')],
      uploadFailures: [{ id: 'row-b', file_name: '사진.png', file: broken }],
    })

    expect(next.kept.map((row) => row.id)).toEqual(['row-old'])
  })
})
