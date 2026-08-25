import { Link } from 'react-router'
import { useCurrentUser } from '../auth/useCurrentUser'
import { isStaff } from '../auth/schema'
import { supabase } from '../../lib/supabase'

export function HomePage() {
  const { user } = useCurrentUser()

  return (
    <div style={{ padding: 18 }}>
      <h1 style={{ fontSize: 26, letterSpacing: -1.2 }}>안녕하세요, {user?.nickname}님</h1>
      <nav style={{ display: 'grid', gap: 9, marginTop: 20 }}>
        <Tile to="/notices" title="공지사항" desc="새 소식과 댓글" />
        <Tile to="/schedule" title="일정" desc="훈련·대회 신청과 대기" />
        <Tile to="/attendance" title="내 출석" desc="출석·지각 기록 보기" />
        <Tile to="/records" title="기록" desc="개인 최고 기록과 변화" />
        {isStaff(user) && <Tile to="/admin/attendance" title="출석 관리" desc="일정별 출석 체크" />}
        {isStaff(user) && <Tile to="/admin/records/new" title="기록 등록" desc="회원별 대회 기록 입력" />}
      </nav>
      <button
        onClick={() => void supabase.auth.signOut()}
        style={{
          marginTop: 24,
          padding: '10px 14px',
          borderRadius: 12,
          border: '1px solid #e1e5ea',
          background: '#fff',
        }}
      >
        로그아웃
      </button>
    </div>
  )
}

function Tile({ to, title, desc }: { to: string; title: string; desc: string }) {
  return (
    <Link
      to={to}
      style={{
        display: 'block',
        padding: 16,
        border: '1px solid #e1e5ea',
        borderRadius: 18,
        background: '#fff',
        textDecoration: 'none',
        color: '#111317',
      }}
    >
      <b style={{ fontSize: 14 }}>{title}</b>
      <p style={{ fontSize: 11, color: '#6b7178', margin: '4px 0 0' }}>{desc}</p>
    </Link>
  )
}
