import type { ReactNode } from 'react'
import { NavLink } from 'react-router'
import { useCurrentUser } from '../../features/auth/useCurrentUser'
import type { Role } from '../../features/auth/schema'

/**
 * The frame every signed-in screen sits in: his sticky .top header above, his
 * fixed .nav below, the screen itself between them.
 *
 * Mounted once on RequireAuth rather than per screen, which is what keeps a new
 * route from having to remember to include it — the same reasoning that put
 * access control in the route tree instead of inside each page.
 *
 * The auth screens deliberately do not get this. His #auth is a fixed overlay
 * at z-index 100 precisely so it covers the header and nav; here they are routes
 * outside RequireAuth, so there is nothing to cover in the first place.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <>
      <TopBar />
      {/* The room the fixed nav needs is reserved here, once, rather than by
          each screen remembering to leave it. His .page carries it instead
          (padding-bottom:98px), which works only because every one of his
          screens is a .page — ours are not yet, and the two that were not had
          their submit button sitting under the nav, unclickable. A screen
          cannot forget a rule it does not have to know about. */}
      <main className="appMain">{children}</main>
      <BottomNav />
    </>
  )
}

const ROLE_LABEL: Record<Role, string> = {
  member: '회원',
  admin: '운영진',
  master_admin: '총관리자',
}

function TopBar() {
  const { user } = useCurrentUser()
  const role = user?.role
  const nickname = user?.nickname ?? ''

  return (
    <header className="top">
      <div className="brandbox">
        <div className="brand">
          <b>TEAM EYSL</b>
          <span>TRAINING CLUB</span>
        </div>
      </div>
      <div className="userbox">
        {role && <span className={`role role-${role}`}>{ROLE_LABEL[role]}</span>}
        {/* His avatar falls back to the first two characters of the nickname when
            there is no uploaded image (upstream:1089). Marked decorative: the
            nickname it abbreviates is already on 마이페이지, so announcing two
            clipped syllables here would only repeat it badly. */}
        <div className="avatar" aria-hidden="true">
          {nickname.slice(0, 2)}
        </div>
      </div>
    </header>
  )
}

/**
 * His five destinations, in his order (upstream, `<nav class="nav">`).
 *
 * NavLink rather than his `showPage()` buttons: these are routes now, so the
 * active state comes from the URL instead of a class the click handler has to
 * remember to move. `end` on 홈 stops "/" matching every path below it.
 */
const TABS = [
  { to: '/members', icon: '◎', label: '회원리스트' },
  { to: '/notices', icon: '▤', label: '공지' },
  { to: '/', icon: '⌂', label: '홈', end: true },
  { to: '/schedule', icon: '◫', label: '신청' },
  { to: '/mypage', icon: '○', label: '마이페이지' },
] as const

function BottomNav() {
  return (
    <nav className="nav" aria-label="주요 메뉴">
      {TABS.map((tab) => (
        <NavLink key={tab.to} to={tab.to} end={'end' in tab ? tab.end : undefined}>
          <i aria-hidden="true">{tab.icon}</i>
          {tab.label}
        </NavLink>
      ))}
    </nav>
  )
}
