import { useState, type FormEvent } from 'react'
import { Navigate } from 'react-router'
import { supabase } from '../../lib/supabase'
import { emailForNickname } from './schema'
import { useSession } from './SessionProvider'

export function LoginPage() {
  const { session, initializing } = useSession()
  const [nickname, setNickname] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (initializing) return <div style={{ padding: 24 }}>불러오는 중…</div>
  if (session) return <Navigate to="/" replace />

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: emailForNickname(nickname),
      password,
    })
    setBusy(false)
    if (signInError) setError('닉네임 또는 비밀번호를 확인해주세요.')
  }

  return (
    <div style={{ padding: 24, maxWidth: 380, margin: '0 auto' }}>
      <h1 style={{ fontSize: 24, letterSpacing: -1 }}>TEAM EYSL</h1>
      <form onSubmit={onSubmit} style={{ display: 'grid', gap: 10, marginTop: 20 }}>
        <input
          aria-label="닉네임"
          placeholder="닉네임"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          style={{ padding: 12, borderRadius: 12, border: '1px solid #e1e5ea' }}
        />
        <input
          aria-label="비밀번호"
          type="password"
          placeholder="비밀번호"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ padding: 12, borderRadius: 12, border: '1px solid #e1e5ea' }}
        />
        <button
          type="submit"
          disabled={busy || !nickname || !password}
          style={{ padding: 12, borderRadius: 12, background: '#111', color: '#fff', border: 0 }}
        >
          {busy ? '로그인 중…' : '로그인'}
        </button>
        {error && <p style={{ color: '#a33', fontSize: 13 }}>{error}</p>}
      </form>
    </div>
  )
}

export function PendingPage() {
  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 20 }}>가입 승인 대기 중</h1>
      <p style={{ color: '#6b7178', fontSize: 14 }}>관리자가 승인하면 이용할 수 있습니다.</p>
    </div>
  )
}
