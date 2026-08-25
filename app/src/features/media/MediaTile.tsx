import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getMediaUrl, type MediaFile } from './api'
import { mediaKind } from './kind'

// Keyframes and prefers-reduced-motion cannot be expressed as inline styles, so
// this one rule set lives in a <style> tag — the same arrangement AsyncSection
// uses for its shimmer. React 19 hoists it and dedupes by href, so a grid of
// thirty tiles still yields a single element.
const SPINNER_CSS = `
@keyframes eysl-spin { to { transform: rotate(360deg) } }
.eysl-spinner {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 2px solid rgba(255,255,255,0.35);
  border-top-color: #fff;
  animation: eysl-spin 0.9s linear infinite;
}
@media (prefers-reduced-motion: reduce) { .eysl-spinner { animation-duration: 2.4s } }
`

const TILE = {
  position: 'relative',
  display: 'block',
  width: '100%',
  aspectRatio: '1 / 1',
  borderRadius: 18,
  border: '1px solid #e1e5ea',
  background: '#fff',
  overflow: 'hidden',
  padding: 0,
} as const

const FILL = { width: '100%', height: '100%', objectFit: 'cover', display: 'block' } as const

const CAPTION = {
  fontSize: 11,
  color: '#6b7178',
  margin: '6px 2px 0',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const

const SR_ONLY = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const

/**
 * A single stored file, loading on its own.
 *
 * AsyncSection's shimmer means "this list has not arrived". Put it under one
 * heavy video and the whole gallery reads as broken while everything except
 * that file is already on screen. So each tile owns its own signed-URL request
 * and its own decode, and covers only itself while it waits.
 */
export function MediaTile({ file }: { file: MediaFile }) {
  const kind = mediaKind(file.mime_type)

  // A generic file needs no URL until somebody asks for it, so it is not signed
  // on render — thirty PDFs in a folder would be thirty pointless requests.
  if (kind === 'file') return <FileTile file={file} />

  return <PreviewTile file={file} kind={kind} />
}

function PreviewTile({ file, kind }: { file: MediaFile; kind: 'image' | 'video' }) {
  const urlQuery = useQuery({
    queryKey: ['media-url', file.id],
    queryFn: () => getMediaUrl(file.storage_path),
    // The URL outlives a tile being scrolled past, and re-signing on remount
    // would restart playback of a video somebody is part-way through.
    staleTime: 30 * 60_000,
  })

  // Tracked separately from the query: holding the URL is not the same as
  // holding the pixels, and the second wait is the long one for a video.
  const [decoded, setDecoded] = useState(false)
  const failed = urlQuery.isError

  return (
    <figure style={{ margin: 0 }}>
      <div style={TILE}>
        <style href="eysl-spinner" precedence="default">
          {SPINNER_CSS}
        </style>

        {urlQuery.data && kind === 'image' && (
          <img
            src={urlQuery.data}
            alt={file.file_name}
            loading="lazy"
            onLoad={() => setDecoded(true)}
            // Also clears the spinner: a tile that will never decode should show
            // the picture that failed, not spin forever.
            onError={() => setDecoded(true)}
            style={FILL}
          />
        )}

        {urlQuery.data && kind === 'video' && (
          <video
            src={urlQuery.data}
            controls
            // metadata, not auto: opening a folder of clips must not pull every
            // one of them down in full.
            preload="metadata"
            playsInline
            onLoadedMetadata={() => setDecoded(true)}
            onError={() => setDecoded(true)}
            style={FILL}
          />
        )}

        {failed ? (
          <Overlay>
            <span style={{ fontSize: 11, color: '#fff' }}>불러오지 못했습니다</span>
            <button
              onClick={() => urlQuery.refetch()}
              style={{
                marginTop: 8,
                minHeight: 44,
                padding: '0 14px',
                borderRadius: 13,
                border: '1px solid rgba(255,255,255,0.6)',
                background: 'transparent',
                color: '#fff',
                fontSize: 12,
              }}
            >
              다시 시도
            </button>
          </Overlay>
        ) : (
          !decoded && (
            <Overlay>
              <span className="eysl-spinner" />
              <span style={SR_ONLY}>{file.file_name} 불러오는 중</span>
            </Overlay>
          )
        )}

        {/* Says a clip is a clip once its first frame is there, so a still
            frame is not mistaken for a photo. */}
        {kind === 'video' && decoded && !failed && (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: 10,
              bottom: 10,
              padding: '2px 8px',
              borderRadius: 999,
              background: 'rgba(17,19,23,0.72)',
              color: '#fff',
              fontSize: 11,
            }}
          >
            ▶ 영상
          </span>
        )}
      </div>

      <figcaption style={CAPTION}>{file.file_name}</figcaption>
    </figure>
  )
}

/** Anything that is not a picture or a clip: an icon, a name, and a way to open it. */
function FileTile({ file }: { file: MediaFile }) {
  const [state, setState] = useState<'idle' | 'opening' | 'error'>('idle')

  async function open() {
    setState('opening')
    try {
      const url = await getMediaUrl(file.storage_path)
      window.open(url, '_blank', 'noopener,noreferrer')
      setState('idle')
    } catch {
      setState('error')
    }
  }

  return (
    <figure style={{ margin: 0 }}>
      <button
        onClick={open}
        disabled={state === 'opening'}
        style={{
          ...TILE,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          background: '#f5f6f8',
        }}
      >
        <style href="eysl-spinner" precedence="default">
          {SPINNER_CSS}
        </style>
        {state === 'opening' ? (
          <span
            className="eysl-spinner"
            style={{ borderColor: '#e1e5ea', borderTopColor: '#6b7178' }}
          />
        ) : (
          <FileIcon />
        )}
        <span
          style={{
            fontSize: 11,
            color: state === 'error' ? '#a33' : '#6b7178',
            padding: '0 10px',
            textAlign: 'center',
          }}
        >
          {state === 'error' ? '열지 못했습니다. 다시 시도' : '파일 열기'}
        </span>
      </button>

      <figcaption style={CAPTION}>{file.file_name}</figcaption>
    </figure>
  )
}

function Overlay({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(17,19,23,0.55)',
      }}
    >
      {children}
    </div>
  )
}

function FileIcon() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"
        stroke="#a9b0b9"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M14 3v5h5" stroke="#a9b0b9" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  )
}
