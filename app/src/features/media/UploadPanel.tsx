import { useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { SaveState } from '../../components/ui/SaveState'
import { uploadMediaFiles, type UploadOutcome } from './api'

const CARD = {
  padding: 14,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
} as const

/**
 * Choose files and put them somewhere.
 *
 * Shared by 미디어 and 자료실 because the difference between them is one null:
 * a media_files row with no folder_id is a 자료실 file (0004:109-110). Only the
 * destination and the caches to refresh differ, so both are parameters rather
 * than a reason for a second copy of this panel.
 */
export function UploadPanel({
  folderId,
  inputId,
  label,
  onUploaded,
}: {
  /** null files into 자료실; a folder id files into that folder. */
  folderId: string | null
  /** Distinct per screen so the <label> points at this screen's own input. */
  inputId: string
  label: string
  /** Refresh whatever this screen shows. Awaited, so 저장됨 means the list agrees. */
  onUploaded: () => Promise<void>
}) {
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
      if (outcome.uploaded.length > 0) await onUploaded()
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
          htmlFor={inputId}
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
          {busy ? '업로드 중…' : label}
        </label>
        <input
          ref={inputRef}
          id={inputId}
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
        <p role="alert" style={{ fontSize: 12, color: '#a33', margin: '10px 0 0', lineHeight: 1.6 }}>
          {failed.length}개 파일을 올리지 못했습니다 · {failed.map((file) => file.name).join(', ')}
        </p>
      )}
    </div>
  )
}
