type Props = { state: 'idle' | 'saving' | 'saved' | 'error'; onRetry?: () => void }

// The attendance bug went unnoticed for so long partly because "toggled but
// unsaved" and "confirmed saved" rendered identically. Every write surface
// shows this.
export function SaveState({ state, onRetry }: Props) {
  if (state === 'idle') return null

  const base = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    padding: '4px 10px',
    borderRadius: 999,
  } as const

  if (state === 'saving')
    return <span style={{ ...base, background: '#eef0f2', color: '#6b7178' }}>저장 중…</span>
  if (state === 'saved')
    return <span style={{ ...base, background: '#edf7f2', color: '#11805b' }}>저장됨</span>

  return (
    <span style={{ ...base, background: '#fff0f0', color: '#a33' }}>
      저장 실패
      {onRetry && (
        <button onClick={onRetry} style={{ marginLeft: 4, fontSize: 12 }}>
          다시 시도
        </button>
      )}
    </span>
  )
}
