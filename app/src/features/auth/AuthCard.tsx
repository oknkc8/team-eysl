import type { ReactNode } from 'react'
import { Link } from 'react-router'

/**
 * The white card on the grey ground that /login, /signup and /pending all share.
 *
 * In his app these three are one element — #auth, a fixed overlay holding a
 * signup form, a login form and a pending panel, with `switchAuthMode()` showing
 * one and hiding the others (upstream:1052-1090). Here they are three routes, so
 * the card is a component and the mode is the URL. Everything the club sees is
 * the same: same wordmark, same tracked subtitle, same 26px radius, same 390px
 * width.
 */
export function AuthCard({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <div className="authbox">
        <h1>TEAM EYSL</h1>
        <small>TRAINING CLUB</small>
        {children}
      </div>
    </div>
  )
}

/**
 * 가입 신청 / 로그인, the segmented pair under the intro sentence.
 *
 * His two tabs are <button>s that swap which form is displayed. Ours are links,
 * because the two forms are two routes and a link is what moves between them —
 * which also means the browser's back button, a long-press, and "open in new
 * tab" all behave, none of which his buttons offer.
 *
 * `aria-current="page"` carries the active state rather than a class, so the
 * styling and what a screen reader announces cannot drift apart.
 */
export function AuthTabs({ active }: { active: 'signup' | 'login' }) {
  return (
    <nav className="segmented" aria-label="가입 신청 또는 로그인">
      <Link to="/signup" aria-current={active === 'signup' ? 'page' : undefined}>
        가입 신청
      </Link>
      <Link to="/login" aria-current={active === 'login' ? 'page' : undefined}>
        로그인
      </Link>
    </nav>
  )
}

/**
 * The sentence under the wordmark, on both form screens.
 *
 * His #authIntro is one string shown in both modes (upstream:1055), so it stays
 * one string here rather than becoming two nearly-identical ones.
 */
export function AuthIntro() {
  return (
    <p className="authIntro">
      처음이라면 가입 신청을, 이미 승인된 회원이라면 로그인해주세요.
      <br />
      승인 후에는 로그인 상태가 유지됩니다.
    </p>
  )
}
