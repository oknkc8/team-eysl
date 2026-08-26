import { useState, type FormEvent } from 'react'
import { Navigate } from 'react-router'
import { supabase } from '../../lib/supabase'
import { AuthCard, AuthIntro, AuthTabs } from './AuthCard'
import { emailForNickname } from './schema'
import { useSession } from './SessionProvider'

export function LoginPage() {
  const { session, initializing } = useSession()
  const [nickname, setNickname] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (initializing) return <AuthCard>불러오는 중…</AuthCard>
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
    <AuthCard>
      <AuthIntro />
      {/* The 가입 신청 half is the only way in for somebody who is not a member
          yet. Until a link to /signup existed anywhere, the screen was built and
          unreachable. */}
      <AuthTabs active="login" />

      <form onSubmit={onSubmit} className="authSimple">
        <input
          className="field"
          aria-label="닉네임"
          placeholder="닉네임"
          autoComplete="username"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
        />
        <input
          className="field"
          aria-label="비밀번호"
          type="password"
          placeholder="비밀번호"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit" className="btn primary block" disabled={busy || !nickname || !password}>
          {busy ? '로그인 중…' : '로그인'}
        </button>
        {error && (
          <p role="alert" className="authMsg error">
            {error}
          </p>
        )}
      </form>

      <p className="authHint">
        닉네임은 중복 사용할 수 없습니다. 가입 때 등록한 닉네임과 비밀번호는 로그인할 때 사용됩니다.
      </p>
    </AuthCard>
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
    <AuthCard>
      <div className="authPending">
        <div className="pendingIcon" aria-hidden="true">
          ✓
        </div>
        <h1>가입 승인 대기 중</h1>
        <p>
          총관리자 승인을 기다려주세요.
          <br />
          승인된 뒤 같은 기기에서 앱을 열면 바로 홈으로 들어갑니다.
        </p>
      </div>

      <div className="authSimple">
        <button onClick={() => void supabase.auth.signOut()} className="btn outline block">
          로그아웃
        </button>
      </div>
    </AuthCard>
  )
}
