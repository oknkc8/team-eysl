import { useState, type FormEvent } from 'react'
import { Link, Navigate } from 'react-router'
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

      {/* The way in for anybody who is not a member yet. Until this link existed
          there was no route to /signup from anywhere in the app, which made the
          screen unreachable even once it was built. */}
      <Link
        to="/signup"
        style={{
          display: 'block',
          marginTop: 14,
          minHeight: 44,
          lineHeight: '44px',
          textAlign: 'center',
          borderRadius: 12,
          border: '1px solid #e1e5ea',
          background: '#fff',
          color: '#111317',
          textDecoration: 'none',
          fontSize: 13,
        }}
      >
        처음이신가요? 가입 신청
      </Link>
    </div>
  )
}

/**
 * Where RequireAuth sends a member whose status is not 'approved'.
 *
 * The sign-out button is the part worth keeping. Without it this screen is a
 * dead end: the session is valid, so /login bounces straight back here, and
 * somebody who signed up on a shared phone has no way to hand it back. His app
 * has the same escape (upstream:1144).
 */
export function PendingPage() {
  return (
    <div style={{ padding: 24, maxWidth: 380, margin: '0 auto', background: '#f5f6f8' }}>
      <div
        style={{
          padding: 18,
          border: '1px solid #e1e5ea',
          borderRadius: 18,
          background: '#fff',
        }}
      >
        <h1 style={{ fontSize: 18, margin: 0 }}>가입 승인 대기 중</h1>
        <p style={{ color: '#6b7178', fontSize: 13, margin: '10px 0 0', lineHeight: 1.6 }}>
          총관리자 승인을 기다려주세요.
          <br />
          승인된 뒤 같은 기기에서 앱을 열면 바로 홈으로 들어갑니다.
        </p>
      </div>

      <button
        onClick={() => void supabase.auth.signOut()}
        style={{
          width: '100%',
          marginTop: 14,
          minHeight: 44,
          borderRadius: 13,
          border: '1px solid #e1e5ea',
          background: '#fff',
          color: '#111317',
          fontSize: 13,
        }}
      >
        로그아웃
      </button>
    </div>
  )
}
