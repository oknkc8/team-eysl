type Props = { state: 'idle' | 'saving' | 'saved' | 'error'; onRetry?: () => void }

// The attendance bug went unnoticed for so long partly because "toggled but
// unsaved" and "confirmed saved" rendered identically. Every write surface
// shows this.
export function SaveState({ state, onRetry }: Props) {
  if (state === 'idle') return null

  if (state === 'saving') return <span className="saveState">저장 중…</span>
  if (state === 'saved') return <span className="saveState saved">저장됨</span>

  return (
    <span className="saveState error">
      저장 실패
      {onRetry && (
        <button onClick={onRetry} className="linkButton">
          다시 시도
        </button>
      )}
    </span>
  )
}
