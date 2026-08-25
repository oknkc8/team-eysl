export type MediaKind = 'image' | 'video' | 'file'

/**
 * What a stored file should be rendered as.
 *
 * Read off the MIME type only, never off the extension. media_files.mime_type
 * defaults to 'application/octet-stream' (0004), so a file whose type the
 * browser could not determine renders as a generic file rather than being
 * guessed at — an icon labelled with its name is honest, while a <video> tag
 * pointed at a PDF is a broken tile that never resolves.
 */
export function mediaKind(mimeType: string | null | undefined): MediaKind {
  const type = (mimeType ?? '').toLowerCase()
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  return 'file'
}
