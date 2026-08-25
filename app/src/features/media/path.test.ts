import { describe, it, expect } from 'vitest'
import { mediaObjectPath, resourceObjectPath, safeObjectName } from './path'

const MEMBER_ID = '00000000-0000-4000-8000-000000000001'
const NOW = 1_756_090_034_969
const NONCE = 'a1b2c3'

describe('safeObjectName', () => {
  it('keeps Hangul, latin letters, digits, dots and dashes', () => {
    expect(safeObjectName('훈련영상-2026.mp4')).toBe('훈련영상-2026.mp4')
  })

  it('collapses runs of unsafe characters into a single underscore', () => {
    expect(safeObjectName('훈련 영상.mp4')).toBe('훈련_영상.mp4')
    expect(safeObjectName('2026 기록지(최종).pdf')).toBe('2026_기록지_최종_.pdf')
  })

  // A slash would invent a folder level and put the object outside the
  // uploader's own prefix, which the storage policy then refuses.
  it('strips path separators', () => {
    expect(safeObjectName('a/b.png')).toBe('a_b.png')
    expect(safeObjectName('a\\b.png')).toBe('a_b.png')
  })

  it('falls back to a name when nothing survives sanitizing', () => {
    expect(safeObjectName('!!!')).toBe('file')
    expect(safeObjectName('')).toBe('file')
    expect(safeObjectName(null)).toBe('file')
    expect(safeObjectName(undefined)).toBe('file')
  })
})

describe('mediaObjectPath', () => {
  it('puts the member id first, which is what the storage policy checks', () => {
    const path = mediaObjectPath({ memberId: MEMBER_ID, fileName: 'x.png', now: NOW, nonce: NONCE })
    expect(path.split('/')[0]).toBe(MEMBER_ID)
  })

  it('builds the whole key from the parts it was given', () => {
    expect(
      mediaObjectPath({ memberId: MEMBER_ID, fileName: '훈련 영상.mp4', now: NOW, nonce: NONCE }),
    ).toBe(`${MEMBER_ID}/media/1756090034969_a1b2c3_훈련_영상.mp4`)
  })

  // Two people uploading the same filename in the same millisecond must not land
  // on one key: the upload runs with upsert:false, so a collision fails the
  // second uploader instead of overwriting the first one's file.
  it('separates two uploads of the same name', () => {
    const first = mediaObjectPath({ memberId: MEMBER_ID, fileName: '사진.jpg', now: NOW })
    const second = mediaObjectPath({ memberId: MEMBER_ID, fileName: '사진.jpg', now: NOW })
    expect(first).not.toBe(second)
  })
})

describe('resourceObjectPath', () => {
  // 자료실 files are media_files rows with a null folder_id, so nothing in the
  // row says which screen put them there. The prefix is what makes a bucket
  // listing readable, and it matches the legacy split (index.html:2749/:2762).
  it('files a resource under resources/ rather than media/', () => {
    expect(
      resourceObjectPath({ memberId: MEMBER_ID, fileName: '회칙.pdf', now: NOW, nonce: NONCE }),
    ).toBe(`${MEMBER_ID}/resources/1756090034969_a1b2c3_회칙.pdf`)
  })

  // Same policy applies to both: team_files_insert (0009) compares the first
  // path segment against current_member_id().
  it('still puts the member id first', () => {
    const path = resourceObjectPath({ memberId: MEMBER_ID, fileName: 'x.pdf', now: NOW })
    expect(path.split('/')[0]).toBe(MEMBER_ID)
  })

  it('sanitizes the name the same way', () => {
    expect(
      resourceObjectPath({ memberId: MEMBER_ID, fileName: 'a/b 안내.pdf', now: NOW, nonce: NONCE }),
    ).toBe(`${MEMBER_ID}/resources/1756090034969_a1b2c3_a_b_안내.pdf`)
  })

  it('does not collide with a media upload of the same name in the same millisecond', () => {
    expect(
      resourceObjectPath({ memberId: MEMBER_ID, fileName: '사진.jpg', now: NOW, nonce: NONCE }),
    ).not.toBe(mediaObjectPath({ memberId: MEMBER_ID, fileName: '사진.jpg', now: NOW, nonce: NONCE }))
  })
})
