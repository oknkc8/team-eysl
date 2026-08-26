import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { useCurrentUser } from '../auth/useCurrentUser'
import { mediaKind } from './kind'
import { MediaItemActions } from './MediaItemActions'
import { UploadPanel } from './UploadPanel'
import {
  deleteMediaFile,
  getMediaUrl,
  listResourceFiles,
  renameMediaFile,
  type MediaFile,
} from './api'

const CARD = {
  padding: 14,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
} as const

const formatCreated = (iso: string) => new Date(iso).toLocaleDateString('ko-KR')

const ICON: Record<ReturnType<typeof mediaKind>, string> = {
  image: '🖼️',
  video: '🎬',
  file: '📄',
}

/**
 * 자료실 — the files that belong to no folder.
 *
 * A list rather than the tile grid /media uses, and that follows from what is
 * in it: 회칙, 신청서, 대회 요강 are documents whose name is the only useful
 * thing to look at, so square thumbnails would be a column of identical icons.
 * The legacy app draws it the same way (index.html:2765, `resourceRow`).
 *
 * RequireAuth, not RequireStaff: media_files_read (0004:241-242) shows these to
 * every approved member, and the legacy 자료실 is on the drawer for everyone.
 */
export function ResourceListPage() {
  const qc = useQueryClient()
  const { user } = useCurrentUser()
  const query = useQuery({ queryKey: ['resource-files'], queryFn: listResourceFiles })

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['resource-files'] })
  }

  return (
    <div className="page">
      <h1 style={{ fontSize: 22, letterSpacing: -0.8, margin: 0 }}>자료실</h1>
      <p style={{ fontSize: 12, color: '#6b7178', margin: '6px 0 0', lineHeight: 1.6 }}>
        폴더에 속하지 않은 공용 자료입니다. 사진과 영상은{' '}
        <Link to="/media" style={{ color: '#11805b' }}>
          미디어
        </Link>
        에 있습니다.
      </p>

      {/* Open to every member, as it is in his app: uploadResourceFiles
          (upstream:2960) has no role check and neither does the button that
          calls it (upstream:1187). media_files_insert (0021) says the same, so
          the screen offers exactly what the database will accept. */}
      <UploadPanel
        folderId={null}
        inputId="resource-upload"
        label="자료 올리기"
        onUploaded={refresh}
      />

      <div style={{ marginTop: 16 }}>
        <AsyncSection
          query={query}
          isEmpty={(rows) => rows.length === 0}
          loading={<Shimmer rows={3} />}
          empty="등록된 자료가 없습니다"
          error="자료를 불러오지 못했습니다"
        >
          {(files) => (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 9 }}>
              {files.map((file) => (
                <li key={file.id} style={CARD}>
                  <ResourceRow
                    file={file}
                    // The uploader alone, mirroring media_files_update /
                    // _delete (0021) and canManageMediaOwner (upstream:2930).
                    // RLS is what enforces it; a member who called the API
                    // anyway would match zero rows.
                    canManage={file.uploader_id === user?.id}
                    onDone={refresh}
                  />
                </li>
              ))}
            </ul>
          )}
        </AsyncSection>
      </div>
    </div>
  )
}

function ResourceRow({
  file,
  canManage,
  onDone,
}: {
  file: MediaFile
  canManage: boolean
  onDone: () => Promise<void>
}) {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span aria-hidden="true" style={{ fontSize: 22 }}>
          {ICON[mediaKind(file.mime_type)]}
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <b style={{ display: 'block', fontSize: 14, wordBreak: 'break-word' }}>{file.file_name}</b>
          <span style={{ fontSize: 11, color: '#6b7178' }}>{formatCreated(file.created_at)}</span>
        </span>
        <OpenButton file={file} />
      </div>

      {canManage && (
        <MediaItemActions
          name={file.file_name}
          confirmMessage={`"${file.file_name}" 자료를 삭제할까요?\n\n자료실 목록과 저장소에서 모두 지워지고 되돌릴 수 없습니다.`}
          onRename={(fileName) => renameMediaFile({ fileId: file.id, fileName })}
          onDelete={() => deleteMediaFile({ fileId: file.id, storagePath: file.storage_path })}
          // One file leaving does not change which screen you are on, so both
          // outcomes are the same refresh here.
          onRenamed={onDone}
          onDeleted={onDone}
        />
      )}
    </>
  )
}

/**
 * Sign on demand, not on render.
 *
 * A 자료실 of thirty documents would otherwise issue thirty signed-URL requests
 * for URLs nobody opens — the same reasoning as MediaTile's FileTile, which
 * signs a generic file only once somebody asks for it.
 */
function OpenButton({ file }: { file: MediaFile }) {
  const query = useQuery({
    queryKey: ['media-url', file.id],
    queryFn: () => getMediaUrl(file.storage_path),
    enabled: false,
  })

  async function open() {
    const result = await query.refetch()
    if (result.data) window.open(result.data, '_blank', 'noopener,noreferrer')
  }

  const busy = query.isFetching

  return (
    <button
      onClick={open}
      disabled={busy}
      style={{
        minHeight: 44,
        padding: '0 14px',
        borderRadius: 13,
        border: query.isError ? '1px solid #a33' : '1px solid #e1e5ea',
        background: '#fff',
        color: query.isError ? '#a33' : '#111317',
        fontSize: 12,
        flexShrink: 0,
      }}
    >
      {busy ? '여는 중…' : query.isError ? '다시 시도' : '열기'}
    </button>
  )
}
