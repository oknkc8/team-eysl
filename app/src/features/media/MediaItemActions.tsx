import { useId, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { SaveState } from '../../components/ui/SaveState'
import type { DeleteOutcome } from './api'

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

const SMALL_BUTTON = {
  minHeight: 44,
  padding: '0 14px',
  borderRadius: 13,
  border: '1px solid #e1e5ea',
  background: '#fff',
  color: '#111317',
  fontSize: 12,
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
 * Rename or delete one folder or one file.
 *
 * An inline field rather than window.prompt, which is what the legacy app uses
 * (index.html:2741, :2759): a prompt cannot show 저장 중…/저장됨, and on a phone
 * it is a modal with no room for the name being replaced. The delete confirm
 * stays a window.confirm — that one is a yes/no with nothing to type, matching
 * every other destructive action here.
 */
export function MediaItemActions({
  name,
  confirmMessage,
  onRename,
  onDelete,
  onRenamed,
  onDeleted,
}: {
  /** Current name, so the field opens with it rather than empty. */
  name: string
  /** Must name what is lost. A folder's has to say its files go too. */
  confirmMessage: string
  onRename: (next: string) => Promise<void>
  onDelete: () => Promise<DeleteOutcome>
  /** Refresh whatever the screen shows. Awaited before 저장됨 appears. */
  onRenamed: () => Promise<void>
  /**
   * Separate from onRenamed because the two outcomes differ for a folder: a
   * rename stays on the screen, a delete has to leave it — there is no longer
   * a folder for it to be about.
   */
  onDeleted: () => Promise<void>
}) {
  const fieldId = useId()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  // How many bucket objects a delete could not remove. The rows are gone either
  // way, so this is reported rather than raised — but it is reported, because
  // silently leaving files somebody pays for is not an honest "삭제됨".
  const [orphans, setOrphans] = useState(0)

  const rename = useMutation({
    mutationFn: (next: string) => onRename(next),
    onMutate: () => setState('saving'),
    onSuccess: async () => {
      setState('saved')
      setEditing(false)
      await onRenamed()
    },
    onError: () => setState('error'),
  })

  const remove = useMutation({
    mutationFn: onDelete,
    onMutate: () => setState('saving'),
    onSuccess: async (outcome) => {
      setOrphans(outcome.orphanedObjects)
      setState('saved')
      await onDeleted()
    },
    onError: () => setState('error'),
  })

  const trimmed = draft.trim()
  const busy = state === 'saving'
  // Renaming to the same text is a write with no meaning, and an empty name
  // would leave a row nobody can identify.
  const canSave = trimmed !== '' && trimmed !== name.trim() && !busy

  function save() {
    if (!canSave) return
    rename.mutate(trimmed)
  }

  function confirmDelete() {
    if (!window.confirm(confirmMessage)) return
    remove.mutate()
  }

  if (editing) {
    return (
      <div style={{ marginTop: 10 }}>
        <label htmlFor={fieldId} style={SR_ONLY}>
          새 이름
        </label>
        <input
          id={fieldId}
          value={draft}
          autoFocus
          onChange={(e) => {
            setDraft(e.target.value)
            if (!busy) setState('idle')
          }}
          // Enter saves and Escape backs out: a one-field form where neither key
          // does anything is a form people conclude is broken.
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
            if (e.key === 'Escape') {
              setDraft(name)
              setEditing(false)
            }
          }}
          style={FIELD}
        />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 7,
            marginTop: 9,
          }}
        >
          <SaveState state={state} onRetry={canSave ? save : undefined} />
          <button
            onClick={() => {
              setDraft(name)
              setEditing(false)
              setState('idle')
            }}
            style={SMALL_BUTTON}
          >
            취소
          </button>
          <button
            onClick={save}
            disabled={!canSave}
            style={{
              ...SMALL_BUTTON,
              border: 'none',
              background: canSave ? '#111317' : '#e1e5ea',
              color: canSave ? '#fff' : '#6b7178',
            }}
          >
            저장
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        <button
          onClick={() => {
            setDraft(name)
            setEditing(true)
            setState('idle')
          }}
          disabled={busy}
          style={SMALL_BUTTON}
        >
          이름 변경
        </button>
        <button
          onClick={confirmDelete}
          disabled={busy}
          style={{ ...SMALL_BUTTON, borderColor: '#a33', color: '#a33' }}
        >
          삭제
        </button>
        {/* Retry re-asks the question rather than re-running the delete: after a
            failure it is no longer obvious what is still there. */}
        <SaveState state={state} onRetry={state === 'error' ? confirmDelete : undefined} />
      </div>

      {/* Deleting the row and deleting the object are two systems answering
          separately, so when the bucket does not answer we say so instead of
          reporting a clean delete.

          The wording changed with 0036 because the situation did. This used to
          mean the object was lost — the row that made it visible was gone, so
          nothing could ever remove it, and telling a 총관리자 was the only
          recourse there was. Now it is queued, and the next session that can
          reach it finishes the job, so what this reports is a delay rather than
          damage. Sending people to ask for help they do not need would be the
          worse message. */}
      {orphans > 0 && (
        <p style={{ fontSize: 11, color: '#925900', margin: '9px 0 0', lineHeight: 1.6 }}>
          목록에서는 지워졌습니다. 저장소 파일 {orphans}개는 곧 정리됩니다.
        </p>
      )}
    </div>
  )
}
