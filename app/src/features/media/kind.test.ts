import { describe, it, expect } from 'vitest'
import { mediaKind } from './kind'

describe('mediaKind', () => {
  it('recognises images and videos by their type prefix', () => {
    expect(mediaKind('image/jpeg')).toBe('image')
    expect(mediaKind('image/png')).toBe('image')
    expect(mediaKind('video/mp4')).toBe('video')
    expect(mediaKind('video/quicktime')).toBe('video')
  })

  it('ignores case, since the type comes from whatever uploaded the file', () => {
    expect(mediaKind('IMAGE/PNG')).toBe('image')
    expect(mediaKind('Video/MP4')).toBe('video')
  })

  it('calls anything else a file', () => {
    expect(mediaKind('application/pdf')).toBe('file')
    expect(mediaKind('text/plain')).toBe('file')
    expect(mediaKind('audio/mpeg')).toBe('file')
  })

  // The column default. A tile that cannot say what it holds shows an icon and
  // a name, which is better than a <video> that will never load.
  it('treats the octet-stream default as a plain file', () => {
    expect(mediaKind('application/octet-stream')).toBe('file')
  })

  it('does not throw on a missing type', () => {
    expect(mediaKind(null)).toBe('file')
    expect(mediaKind(undefined)).toBe('file')
    expect(mediaKind('')).toBe('file')
  })

  // The separator is part of the test: a type that merely starts with the same
  // letters is not an image.
  it('requires the type separator rather than a bare prefix', () => {
    expect(mediaKind('imaginary/thing')).toBe('file')
    expect(mediaKind('videography')).toBe('file')
  })
})
