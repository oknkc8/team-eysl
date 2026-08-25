import { describe, it, expect } from 'vitest'
import { avatarObjectPath, safeExtension } from './avatarPath'

const MEMBER = '00000000-0000-4000-8000-000000000001'
const NOW = 1756100000000

// The shape is_my_avatar_object_path (0027) matches. Written out here rather
// than imported, so a change to the builder has to disagree with a literal
// rather than with itself.
const AVATAR_SHAPE = new RegExp(`^${MEMBER}/[^/]+$`)

describe('avatarObjectPath', () => {
  it('builds the president’s key: <memberId>/avatar-<millis>.<ext>', () => {
    expect(avatarObjectPath({ memberId: MEMBER, fileName: 'photo.png', now: NOW })).toBe(
      `${MEMBER}/avatar-${NOW}.png`,
    )
  })

  // The property the database actually enforces. Every one of these keys must
  // match, because a key that does not is refused twice — by the storage policy
  // and by set_my_avatar_path_v1.
  it('produces a two-segment key for names that could break one', () => {
    for (const fileName of [
      'photo.png',
      '사진.JPG',
      'holiday.photo.jpeg',
      'no-extension',
      'trailing.',
      'a/b/c.png',
      '.gitignore',
      '',
    ]) {
      const path = avatarObjectPath({ memberId: MEMBER, fileName, now: NOW })
      expect(path, `built from ${JSON.stringify(fileName)}`).toMatch(AVATAR_SHAPE)
    }
  })

  it('starts with the member id, which is what the policy compares', () => {
    const path = avatarObjectPath({ memberId: MEMBER, fileName: 'photo.png', now: NOW })
    expect(path.startsWith(`${MEMBER}/`)).toBe(true)
  })

  // Two uploads by one member must not collide: the upload is issued with
  // upsert:false, so a shared key would fail the second one.
  it('gives two uploads different keys', () => {
    const first = avatarObjectPath({ memberId: MEMBER, fileName: 'photo.png', now: NOW })
    const second = avatarObjectPath({ memberId: MEMBER, fileName: 'photo.png', now: NOW + 1 })
    expect(first).not.toBe(second)
  })
})

describe('safeExtension', () => {
  it('lowercases what it keeps', () => {
    expect(safeExtension('사진.JPG')).toBe('jpg')
  })

  it('takes the last extension, not the first', () => {
    expect(safeExtension('holiday.photo.jpeg')).toBe('jpeg')
  })

  it('strips characters that do not belong in an object key', () => {
    expect(safeExtension('photo.p n g!')).toBe('png')
  })

  it('falls back to jpg rather than producing a bare or empty extension', () => {
    expect(safeExtension('no-extension')).toBe('jpg')
    expect(safeExtension('trailing.')).toBe('jpg')
    expect(safeExtension('')).toBe('jpg')
    expect(safeExtension(null)).toBe('jpg')
    expect(safeExtension(undefined)).toBe('jpg')
  })

  // A dotfile's leading dot is not an extension marker, but treating it as one
  // still yields a usable key rather than an empty segment.
  it('handles a dotfile without producing an empty extension', () => {
    expect(safeExtension('.gitignore')).toBe('gitignore')
  })
})
