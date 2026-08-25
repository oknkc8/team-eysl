import { useState, type FormEvent } from 'react'
import { Link, Navigate } from 'react-router'
import { SaveState } from '../../components/ui/SaveState'
import { registerMember } from './api'
import { AuthCard, AuthIntro, AuthTabs } from './AuthCard'
import { NICKNAME_MAX, signupErrorMessage, validateSignup } from './signup'
import { useSession } from './SessionProvider'

// The president asks for two things and no more (upstream:1064-1068): a nickname
// and a password. Not 실명, not 생년월일, not a phone number — his approval queue
// shows those fields, but they are filled in later, and 실명 has its own card on
// 마이페이지 where the reason for asking can be explained. Widening the first
// screen anyone outside the club ever sees was not ours to decide.

export function SignupPage() {
  const { session, initializing } = useSession()
  const [nickname, setNickname] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  if (initializing) return <AuthCard>불러오는 중…</AuthCard>

  // Already signed in: RequireAuth decides where they belong — home if approved,
  // /pending if not. Deciding it here as well would be a second answer to the
  // same question. Signing up no longer produces a session — register_member_v1
  // creates the account and nothing else, so the applicant logs in afterwards —
  // but the state check stays: without it, opening this screen in a tab that is
  // already signed in would redirect away from a completion panel somebody is
  // still reading.
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
      // Two outcomes, not one. A refusal the server decided on — a taken
      // nickname, a password under eight, too many attempts from this address —
      // arrives as a returned value with its own Korean sentence, because
      // register_member_v1 answers those with a 200 so its rate-limit counter
      // survives (0028). Only a transport failure throws.
      const refused = await registerMember({ nickname, password })
      if (refused) {
        setError(refused.message)
        setState('error')
        return
      }
      setState('saved')
    } catch (cause) {
      setError(signupErrorMessage(cause as { message?: string; status?: number }))
      setState('error')
    }
  }

  if (state === 'saved') return <Submitted nickname={nickname.trim()} />

  return (
    <AuthCard>
      <AuthIntro />
      <AuthTabs active="signup" />

      <form onSubmit={onSubmit} className="authSimple">
        <input
          className="field"
          aria-label="닉네임"
          placeholder="닉네임"
          maxLength={NICKNAME_MAX}
          autoComplete="username"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
        />
        <input
          className="field"
          aria-label="비밀번호"
          type="password"
          placeholder="비밀번호 (8자 이상)"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit" className="btn primary block" disabled={state === 'saving'}>
          {state === 'saving' ? '신청 중…' : '가입 신청'}
        </button>

        {/* Only ever 'saving' or 'error' here — the success branch has already
            replaced the whole form with <Submitted />. */}
        <SaveState state={state} />

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
 * 가입 신청 완료 — his wording (upstream:1076-1081), minus the push button.
 *
 * The second sentence is the one that matters: it tells somebody who cannot get
 * in yet that waiting is the correct thing to be doing, rather than leaving them
 * to guess whether the form worked.
 */
function Submitted({ nickname }: { nickname: string }) {
  return (
    <AuthCard>
      <div className="authPending">
        <div className="pendingIcon" aria-hidden="true">
          ✓
        </div>
        <h1>{nickname} 가입 신청 완료</h1>
        <p>
          총관리자 승인을 기다려주세요.
          <br />
          승인된 뒤 같은 기기에서 앱을 열면 바로 홈으로 들어갑니다.
        </p>
      </div>

      <div className="authSimple">
        <Link to="/login" className="btn primary block">
          로그인 화면으로
        </Link>
      </div>
    </AuthCard>
  )
}
