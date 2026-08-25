import { Link } from 'react-router'
import { useCurrentUser } from '../auth/useCurrentUser'
import { isStaff } from '../auth/schema'
import { supabase } from '../../lib/supabase'

export function HomePage() {
  const { user } = useCurrentUser()
  const staff = isStaff(user)

  return (
    <div className="page">
      <h1 className="title">안녕하세요, {user?.nickname}님</h1>

      <nav className="list" aria-label="바로가기">
        <Tile to="/notices" icon="▤" title="공지사항" desc="새 소식과 댓글" />
        <Tile to="/schedule" icon="◫" title="일정" desc="훈련·대회 신청과 대기" />
        <Tile
          to="/schedule/mine"
          icon="◇"
          title="나의 대회 신청 내역"
          desc="신청한 대회와 지난 참가 기록"
        />
        <Tile to="/attendance" icon="✓" title="내 출석" desc="출석·지각 기록 보기" />
        <Tile to="/records" icon="⏱" title="기록" desc="개인 최고 기록과 변화" />
        <Tile to="/events" icon="♛" title="이벤트" desc="출석왕·지각왕·단축왕 랭킹" />
        <Tile to="/chat" icon="✉" title="채팅" desc="단체 대화와 1:1 메시지" />
        <Tile to="/mypage" icon="○" title="마이페이지" desc="프로필 사진과 실명, 내 메뉴" />
        <Tile to="/settings/notifications" icon="🔔" title="알림 설정" desc="이 기기로 알림 받기" />
      </nav>

      {/* 운영진 전용. A separate section rather than four more rows in the list
          above, because a staffer reading their own screen should be able to see
          where their own menu ends and the club's management begins. */}
      {staff && (
        <>
          <div className="section">
            <h2>운영</h2>
          </div>
          <nav className="list" aria-label="운영 메뉴">
            <Tile to="/admin/attendance" icon="◎" title="출석 관리" desc="일정별 출석 체크" />
            <Tile
              to="/admin/applications"
              icon="▤"
              title="활동 취합본"
              desc="일정별 신청자와 대기자"
            />
            <Tile to="/admin/records/new" icon="✎" title="기록 등록" desc="회원별 대회 기록 입력" />
            <Tile
              to="/admin/records/upload"
              icon="↥"
              title="결과지 업로드"
              desc="엑셀 결과지에서 기록 읽기"
            />
          </nav>
        </>
      )}

      <div className="actions">
        <button onClick={() => void supabase.auth.signOut()} className="btn outline">
          로그아웃
        </button>
      </div>
    </div>
  )
}

function Tile({
  to,
  icon,
  title,
  desc,
}: {
  to: string
  icon: string
  title: string
  desc: string
}) {
  return (
    <Link to={to} className="row">
      <span className="icon" aria-hidden="true">
        {icon}
      </span>
      {/* A div rather than a span: <p> is flow content and may not sit inside a
          span, while <a> takes flow content happily. */}
      <div className="grow">
        <b>{title}</b>
        <p>{desc}</p>
      </div>
    </Link>
  )
}
