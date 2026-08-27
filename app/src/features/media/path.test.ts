import { describe, it, expect } from 'vitest'
import { mediaObjectPath, resourceObjectPath, safeObjectName } from './path'

const MEMBER_ID = '00000000-0000-4000-8000-000000000001'
const NOW = 1_756_090_034_969
const NONCE = 'a1b2c3'

describe('safeObjectName', () => {
  // THE RULE THIS ENCODES, and it is the opposite of what it used to be.
  //
  // It kept 가-힣 on purpose so a Korean filename stayed readable. Supabase
  // Storage refuses such a key outright — 400 InvalidKey — so every upload in the
  // app failed for the ordinary Korean case while every gate stayed green,
  // because nothing in this repository sent bytes to storage. The readable name
  // now lives in the claim table's file_name column; the key is only an
  // identifier.
  it('produces ASCII only, whatever it is given', () => {
    const inputs = [
      '훈련일지.txt',
      '사진.png',
      '写真.jpeg',
      'фото.gif',
      '🏊‍♀️ 기록.pdf',
      'a b(c)[d]{e}.txt',
      '  공백  앞뒤  .csv',
      'no-extension-한글',
      '.gitignore',
      '',
    ]
    for (const input of inputs) {
      const out = safeObjectName(input)
      // eslint-disable-next-line no-control-regex
      expect(out, `input: ${input}`).toMatch(/^[A-Za-z0-9.\-_]+$/)
    }
  })

  it('keeps a name that is already safe', () => {
    expect(safeObjectName('training-log.txt')).toBe('training-log.txt')
    expect(safeObjectName('2026_기록.csv')).toBe('2026.csv')
  })

  it('keeps the extension when the stem does not survive', () => {
    // `.mp4` alone would read as a dotfile with no name, and `-2026.mp4` as a
    // flag — which is why stem and extension are sanitized separately.
    expect(safeObjectName('훈련_영상.mp4')).toBe('file.mp4')
    expect(safeObjectName('사진.png')).toBe('file.png')
    expect(safeObjectName('훈련영상-2026.mp4')).toBe('2026.mp4')
  })

  it('falls back to a name when nothing survives at all', () => {
    expect(safeObjectName('한글')).toBe('file')
    expect(safeObjectName('')).toBe('file')
    expect(safeObjectName(null)).toBe('file')
    expect(safeObjectName(undefined)).toBe('file')
  })

  it('treats a leading dot as part of the stem, not an extension', () => {
    expect(safeObjectName('.gitignore')).toBe('gitignore')
  })

  it('collapses runs of unsafe characters into a single underscore', () => {
    expect(safeObjectName('a???b.txt')).toBe('a_b.txt')
  })

  it('strips path separators', () => {
    expect(safeObjectName('a/b/c.txt')).toBe('a_b_c.txt')
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
    ).toBe(`${MEMBER_ID}/media/1756090034969_a1b2c3_file.mp4`)
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
    ).toBe(`${MEMBER_ID}/resources/1756090034969_a1b2c3_file.pdf`)
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
    ).toBe(`${MEMBER_ID}/resources/1756090034969_a1b2c3_a_b.pdf`)
  })

  it('does not collide with a media upload of the same name in the same millisecond', () => {
    expect(
      resourceObjectPath({ memberId: MEMBER_ID, fileName: '사진.jpg', now: NOW, nonce: NONCE }),
    ).not.toBe(mediaObjectPath({ memberId: MEMBER_ID, fileName: '사진.jpg', now: NOW, nonce: NONCE }))
  })
})
