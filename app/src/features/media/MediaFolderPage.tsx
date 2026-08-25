import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { SaveState } from '../../components/ui/SaveState'
import { useCurrentUser } from '../auth/useCurrentUser'
import { isStaff } from '../auth/schema'
import { MediaTile } from './MediaTile'
import {
  getFolder,
  listFolderFiles,
  uploadMediaFiles,
  type MediaFile,
  type UploadOutcome,
} from './api'

const CARD = {
  padding: 14,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
} as const

export function MediaFolderPage() {
  const { folderId = '' } = useParams()
  const { user } = useCurrentUser()

  const folderQuery = useQuery({
    queryKey: ['media-folder', folderId],
    queryFn: () => getFolder(folderId),
    enabled: folderId !== '',
  })

  const filesQuery = useQuery({
    queryKey: ['media-files', folderId],
    queryFn: () => listFolderFiles(folderId),
    enabled: folderId !== '',
  })

  return (
    <div style={{ padding: 18, background: '#f5f6f8', minHeight: '100vh' }}>
      <Link to="/media" style={{ fontSize: 12, color: '#6b7178', textDecoration: 'none' }}>
        ← 미디어
      </Link>

      {/* The name is its own section rather than part of the file list, so a
          folder that has loaded still has a heading while its files arrive. */}
      <AsyncSection
        query={folderQuery}
        loading={<Shimmer rows={1} />}
        error="폴더를 불러오지 못했습니다"
      >
        {(folder) => (
          <h1 style={{ fontSize: 22, letterSpacing: -0.8, margin: '12px 0 0' }}>{folder.name}</h1>
        )}
      </AsyncSection>

      {/* Presentation only — media_files_insert (0004) accepts any approved
          member, so this hides the control rather than withholding the ability. */}
      {isStaff(user) && <UploadPanel folderId={folderId} />}

      <div style={{ marginTop: 16 }}>
        <AsyncSection
          query={filesQuery}
          isEmpty={(rows) => rows.length === 0}
          loading={<Shimmer rows={3} />}
          empty="아직 공유된 파일이 없습니다"
          error="파일을 불러오지 못했습니다"
        >
          {(files) => <Gallery files={files} />}
        </AsyncSection>
      </div>
    </div>
  )
}

function Gallery({ files }: { files: MediaFile[] }) {
  return (
    <ul
      style={{
        listStyle: 'none',
        padding: 0,
        margin: 0,
        display: 'grid',
        gap: 12,
        gridTemplateColumns: 'repeat(auto-fill, minmax(148px, 1fr))',
      }}
    >
      {files.map((file) => (
        <li key={file.id}>
          {/* Each tile loads and reports on itself, so a slow video covers its
              own square with a spinner rather than putting the list skeleton
              over a gallery that is otherwise already there. */}
          <MediaTile file={file} />
        </li>
      ))}
    </ul>
  )
}

function UploadPanel({ folderId }: { folderId: string }) {
  const qc = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  // The files that did not land, kept as File objects so 다시 시도 re-sends
  // exactly those. Re-sending the whole selection would duplicate everything
  // that already worked.
  const [failed, setFailed] = useState<File[]>([])

  const upload = useMutation({
    mutationFn: (files: File[]) => uploadMediaFiles({ folderId, files }),
    onMutate: () => setState('saving'),
    onSuccess: async (outcome: UploadOutcome) => {
      setFailed(outcome.failed)
      // A partial success is reported as a failure on purpose: what the uploader
      // needs to know is that something did not land, and the line below names
      // which files.
      setState(outcome.failed.length > 0 ? 'error' : 'saved')

      if (outcome.uploaded.length > 0) {
        await qc.invalidateQueries({ queryKey: ['media-files', folderId] })
        // The grid on /media carries a per-folder count, now short by however
        // many just landed.
        await qc.invalidateQueries({ queryKey: ['media-folders'] })
        await qc.invalidateQueries({ queryKey: ['media-folder', folderId] })
      }
    },
    onError: () => setState('error'),
  })

  function pick(files: FileList | null) {
    const chosen = Array.from(files ?? [])
    if (chosen.length === 0) return
    setFailed([])
    upload.mutate(chosen)
    // Cleared so choosing the same file again still fires a change event.
    if (inputRef.current) inputRef.current.value = ''
  }

  const busy = state === 'saving'

  return (
    <div style={{ ...CARD, marginTop: 14 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 9,
          flexWrap: 'wrap',
        }}
      >
        <label
          htmlFor="media-upload"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            minHeight: 44,
            padding: '0 18px',
            borderRadius: 13,
            background: busy ? '#e1e5ea' : '#111317',
            color: busy ? '#6b7178' : '#fff',
            fontSize: 13,
          }}
        >
          {busy ? '업로드 중…' : '파일 올리기'}
        </label>
        <input
          ref={inputRef}
          id="media-upload"
          type="file"
          multiple
          disabled={busy}
          onChange={(e) => pick(e.target.files)}
          // Visually hidden rather than absent: the styled <label> above is the
          // control, and the input stays in the tree so it keeps its own focus
          // and keyboard behaviour.
          style={{
            position: 'absolute',
            width: 1,
            height: 1,
            overflow: 'hidden',
            clip: 'rect(0 0 0 0)',
          }}
        />
        <SaveState
          state={state}
          onRetry={failed.length > 0 ? () => upload.mutate(failed) : undefined}
        />
      </div>

      {failed.length > 0 && (
        <p
          role="alert"
          style={{ fontSize: 12, color: '#a33', margin: '10px 0 0', lineHeight: 1.6 }}
        >
          {failed.length}개 파일을 올리지 못했습니다 · {failed.map((file) => file.name).join(', ')}
        </p>
      )}
    </div>
  )
}
