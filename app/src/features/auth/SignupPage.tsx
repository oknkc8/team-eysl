import { useState, type FormEvent } from 'react'
import { Link, Navigate } from 'react-router'
import { SaveState } from '../../components/ui/SaveState'
import { registerMember } from './api'
import { NICKNAME_MAX, signupErrorMessage, validateSignup } from './signup'
import { useSession } from './SessionProvider'

// The president asks for two things and no more (upstream:1064-1068): a nickname
// and a password. Not 실명, not 생년월일, not a phone number — his approval queue
// shows those fields, but they are filled in later, and 실명 has its own card on
// 마이페이지 where the reason for asking can be explained. Widening the first
// screen anyone outside the club ever sees was not ours to decide.
const FIELD = {
  padding: 12,
  minHeight: 44,
  borderRadius: 13,
  border: '1px solid #e1e5ea',
  background: '#fff',
  fontSize: 14,
} as const

const CARD = {
  padding: 18,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
} as const

const LINK_BUTTON = {
  display: 'block',
  marginTop: 14,
  minHeight: 44,
  lineHeight: '44px',
  textAlign: 'center',
  borderRadius: 13,
  textDecoration: 'none',
  fontSize: 13,
} as const

export function SignupPage() {
  const { session, initializing } = useSession()
  const [nickname, setNickname] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  if (initializing) return <div style={{ padding: 24 }}>불러오는 중…</div>

  // Already signed in: RequireAuth decides where they belong — home if approved,
  // /pending if not. Deciding it here as well would be a second answer to the
  // same question. The state check keeps a successful signup on its own
  // completion panel, since signUp may have returned a session.
  if (session && state !== 'saved') return <Navigate to="/" replace />

  async function onSubmit(e: FormEvent) {
    e.preventDefault()

    const refusal = validateSignup({ nickname, password })
    if (refusal) {
      setError(refusal)
      setState('error')
      return
    }

    setState('saving')
    setError(null)
    try {
      await registerMember({ nickname, password })
      setState('saved')
    } catch (cause) {
      setError(signupErrorMessage(cause as { message?: string; status?: number }))
      setState('error')
    }
  }

  if (state === 'saved') return <Submitted nickname={nickname.trim()} />

  return (
    <div style={{ padding: 24, maxWidth: 380, margin: '0 auto', background: '#f5f6f8' }}>
      <h1 style={{ fontSize: 24, letterSpacing: -1, margin: 0 }}>TEAM EYSL</h1>
      <p style={{ fontSize: 12, color: '#6b7178', margin: '6px 0 0' }}>
        처음이라면 가입 신청을, 이미 승인된 회원이라면 로그인해주세요.
      </p>

      <form onSubmit={onSubmit} style={{ display: 'grid', gap: 10, marginTop: 20 }}>
        <input
          aria-label="닉네임"
          placeholder="닉네임"
          maxLength={NICKNAME_MAX}
          autoComplete="username"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          style={FIELD}
        />
        <input
          aria-label="비밀번호"
          type="password"
          placeholder="비밀번호 (8자 이상)"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={FIELD}
        />
        <button
          type="submit"
          disabled={state === 'saving'}
          style={{
            minHeight: 44,
            borderRadius: 13,
            background: state === 'saving' ? '#e1e5ea' : '#11805b',
            color: state === 'saving' ? '#6b7178' : '#fff',
            border: 0,
            fontSize: 14,
          }}
        >
          {state === 'saving' ? '신청 중…' : '가입 신청'}
        </button>

        {/* Only ever 'saving' or 'error' here — the success branch has already
            replaced the whole form with <Submitted />. */}
        <SaveState state={state} />

        {error && (
          <p role="alert" style={{ color: '#a33', fontSize: 13, margin: 0 }}>
            {error}
          </p>
        )}
      </form>

      <p style={{ fontSize: 12, color: '#6b7178', marginTop: 18, lineHeight: 1.6 }}>
        닉네임은 중복 사용할 수 없습니다. 가입할 때 등록한 닉네임과 비밀번호로 로그인합니다.
      </p>

      <Link
        to="/login"
        style={{ ...LINK_BUTTON, border: '1px solid #e1e5ea', background: '#fff', color: '#111317' }}
      >
        이미 승인된 회원이신가요? 로그인
      </Link>
    </div>
  )
}

/**
 * 가입 신청 완료 — his wording (upstream:1076-1081), minus the push button.
 *
 * The second sentence is the one that matters: it tells somebody who cannot get
 * in yet that waiting is the correct thing to be doing, rather than leaving them
 * to guess whether the form worked.
 */
function Submitted({ nickname }: { nickname: string }) {
  return (
    <div style={{ padding: 24, maxWidth: 380, margin: '0 auto', background: '#f5f6f8' }}>
      <div style={{ ...CARD, textAlign: 'center' }}>
        <div
          aria-hidden="true"
          style={{
            width: 44,
            height: 44,
            margin: '0 auto',
            borderRadius: '50%',
            background: '#edf7f2',
            color: '#11805b',
            fontSize: 20,
            lineHeight: '44px',
          }}
        >
          ✓
        </div>
        <h1 style={{ fontSize: 18, margin: '12px 0 0' }}>{nickname} 가입 신청 완료</h1>
        <p style={{ fontSize: 13, color: '#6b7178', margin: '10px 0 0', lineHeight: 1.6 }}>
          총관리자 승인을 기다려주세요.
          <br />
          승인된 뒤 같은 기기에서 앱을 열면 바로 홈으로 들어갑니다.
        </p>
      </div>

      <Link to="/login" style={{ ...LINK_BUTTON, background: '#111317', color: '#fff' }}>
        로그인 화면으로
      </Link>
    </div>
  )
}
