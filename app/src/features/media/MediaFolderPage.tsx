import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { useCurrentUser } from '../auth/useCurrentUser'
import { isStaff } from '../auth/schema'
import { MediaItemActions } from './MediaItemActions'
import { MediaTile } from './MediaTile'
import { UploadPanel } from './UploadPanel'
import {
  deleteFolder,
  deleteMediaFile,
  getFolder,
  listFolderFiles,
  renameFolder,
  renameMediaFile,
  type MediaFile,
  type MediaFolder,
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
  const qc = useQueryClient()
  const navigate = useNavigate()

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

  // Every write on this screen changes both the file list and the per-folder
  // count the grid on /media shows, so they refresh together rather than each
  // caller remembering three keys.
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['media-files', folderId] })
    await qc.invalidateQueries({ queryKey: ['media-folders'] })
    await qc.invalidateQueries({ queryKey: ['media-folder', folderId] })
  }

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
          <FolderHeader
            folder={folder}
            // Mirrors media_folders_update / _delete (0004:232-238). RLS is what
            // enforces it; a member who called the API anyway would match zero
            // rows, which renameFolder/deleteFolder report as a refusal.
            canManage={folder.created_by === user?.id || isStaff(user)}
            onRenamed={refresh}
            // After the folder is gone there is nothing left on this screen to
            // show, so leave rather than render a heading for a deleted row.
            onDeleted={async () => {
              await refresh()
              navigate('/media', { replace: true })
            }}
          />
        )}
      </AsyncSection>

      {/* Presentation only — media_files_insert (0004) accepts any approved
          member, so this hides the control rather than withholding the ability. */}
      {isStaff(user) && (
        <UploadPanel
          folderId={folderId}
          inputId="media-upload"
          label="파일 올리기"
          onUploaded={refresh}
        />
      )}

      <div style={{ marginTop: 16 }}>
        <AsyncSection
          query={filesQuery}
          isEmpty={(rows) => rows.length === 0}
          loading={<Shimmer rows={3} />}
          empty="아직 공유된 파일이 없습니다"
          error="파일을 불러오지 못했습니다"
        >
          {(files) => <Gallery files={files} onDone={refresh} />}
        </AsyncSection>
      </div>
    </div>
  )
}

function FolderHeader({
  folder,
  canManage,
  onRenamed,
  onDeleted,
}: {
  folder: MediaFolder
  canManage: boolean
  onRenamed: () => Promise<void>
  onDeleted: () => Promise<void>
}) {
  // media_files.folder_id cascades (0004:110), so deleting the folder takes
  // every file in it. The count is already loaded here, so the confirm can say
  // how many rather than warn about "the files" in the abstract.
  const confirmMessage =
    folder.file_count === 0
      ? `"${folder.name}" 폴더를 삭제할까요?\n\n되돌릴 수 없습니다.`
      : `"${folder.name}" 폴더를 삭제할까요?\n\n안에 있는 파일 ${folder.file_count}개도 함께 삭제되고 되돌릴 수 없습니다.`

  return (
    <div style={{ ...CARD, marginTop: 12 }}>
      <h1 style={{ fontSize: 22, letterSpacing: -0.8, margin: 0, wordBreak: 'break-word' }}>
        {folder.name}
      </h1>
      <p style={{ fontSize: 11, color: '#6b7178', margin: '6px 0 0' }}>
        파일 {folder.file_count}개
      </p>

      {canManage && (
        <MediaItemActions
          name={folder.name}
          confirmMessage={confirmMessage}
          onRename={(name) => renameFolder({ folderId: folder.id, name })}
          onDelete={() => deleteFolder(folder.id)}
          onRenamed={onRenamed}
          onDeleted={onDeleted}
        />
      )}
    </div>
  )
}

function Gallery({ files, onDone }: { files: MediaFile[]; onDone: () => Promise<void> }) {
  const { user } = useCurrentUser()

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
          {(file.uploader_id === user?.id || isStaff(user)) && (
            <MediaItemActions
              name={file.file_name}
              confirmMessage={`"${file.file_name}" 파일을 삭제할까요?\n\n폴더와 저장소에서 모두 지워지고 되돌릴 수 없습니다.`}
              onRename={(fileName) => renameMediaFile({ fileId: file.id, fileName })}
              onDelete={() => deleteMediaFile({ fileId: file.id, storagePath: file.storage_path })}
              // One file leaving does not change which screen you are on, so
              // both outcomes are the same refresh here.
              onRenamed={onDone}
              onDeleted={onDone}
            />
          )}
        </li>
      ))}
    </ul>
  )
}
