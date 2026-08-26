import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { SaveState } from '../../components/ui/SaveState'
import { createFolder, listFolders, type MediaFolder } from './api'

const CARD = {
  padding: 14,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
} as const

const FIELD = {
  width: '100%',
  boxSizing: 'border-box',
  padding: 12,
  minHeight: 44,
  borderRadius: 13,
  border: '1px solid #e1e5ea',
  fontSize: 14,
  fontFamily: 'inherit',
} as const

const LABEL = { display: 'block', fontSize: 12, color: '#6b7178', marginBottom: 6 } as const

const formatCreated = (iso: string) => new Date(iso).toLocaleDateString('ko-KR')

export function MediaFolderListPage() {
  const query = useQuery({ queryKey: ['media-folders'], queryFn: listFolders })

  return (
    <div className="page">
      <h1 style={{ fontSize: 22, letterSpacing: -0.8, margin: 0 }}>미디어</h1>
      <p style={{ fontSize: 12, color: '#6b7178', margin: '6px 0 0', lineHeight: 1.6 }}>
        폴더에 속하지 않은 문서는{' '}
        <Link to="/files" style={{ color: '#11805b' }}>
          자료실
        </Link>
        에 있습니다.
      </p>

      {/* Any member may start a folder, which is what his createFolder()
          (upstream:2939) and its always-rendered button (upstream:1185) do.
          media_folders_insert (0021) admits exactly the same people, and only
          in their own name. */}
      <NewFolderForm />

      <div style={{ marginTop: 16 }}>
        <AsyncSection
          query={query}
          isEmpty={(rows) => rows.length === 0}
          loading={<Shimmer rows={3} />}
          empty="아직 폴더가 없습니다"
          error="폴더를 불러오지 못했습니다"
        >
          {(folders) => <FolderGrid folders={folders} />}
        </AsyncSection>
      </div>
    </div>
  )
}

function NewFolderForm() {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  const create = useMutation({
    mutationFn: (folderName: string) => createFolder(folderName),
    onMutate: () => setState('saving'),
    onSuccess: async () => {
      setState('saved')
      setName('')
      await qc.invalidateQueries({ queryKey: ['media-folders'] })
    },
    onError: () => setState('error'),
  })

  const trimmed = name.trim()
  const canSubmit = trimmed !== '' && state !== 'saving'

  function submit() {
    if (!canSubmit) return
    create.mutate(trimmed)
  }

  return (
    <div style={{ ...CARD, marginTop: 14 }}>
      <label htmlFor="folder-name" style={LABEL}>
        새 폴더
      </label>
      <input
        id="folder-name"
        value={name}
        onChange={(e) => {
          setName(e.target.value)
          if (state !== 'saving') setState('idle')
        }}
        // Enter submits: a one-field form where it does nothing is a form people
        // conclude is broken.
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
        placeholder="예: 2026 춘계대회"
        style={FIELD}
      />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 9,
          marginTop: 12,
        }}
      >
        <SaveState state={state} onRetry={canSubmit ? submit : undefined} />
        <button
          onClick={submit}
          disabled={!canSubmit}
          style={{
            minHeight: 44,
            minWidth: 96,
            padding: '0 18px',
            borderRadius: 13,
            border: 'none',
            background: canSubmit ? '#111317' : '#e1e5ea',
            color: canSubmit ? '#fff' : '#6b7178',
            fontSize: 13,
          }}
        >
          만들기
        </button>
      </div>
    </div>
  )
}

function FolderGrid({ folders }: { folders: MediaFolder[] }) {
  return (
    <ul
      style={{
        listStyle: 'none',
        padding: 0,
        margin: 0,
        display: 'grid',
        gap: 9,
        // Reflows from one column on a phone to several on a tablet without a
        // media query, which inline styles cannot express.
        gridTemplateColumns: 'repeat(auto-fill, minmax(148px, 1fr))',
      }}
    >
      {folders.map((folder) => (
        <li key={folder.id}>
          <Link
            to={`/media/${folder.id}`}
            style={{
              ...CARD,
              display: 'block',
              minHeight: 44,
              textDecoration: 'none',
              color: '#111317',
            }}
          >
            <span aria-hidden="true" style={{ fontSize: 24 }}>
              📁
            </span>
            <b
              style={{
                display: 'block',
                fontSize: 14,
                margin: '8px 0 4px',
                wordBreak: 'break-word',
              }}
            >
              {folder.name}
            </b>
            <span style={{ fontSize: 11, color: '#6b7178' }}>
              {formatCreated(folder.created_at)} · 파일 {folder.file_count}개
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}
