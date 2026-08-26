import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { useCurrentUser } from '../auth/useCurrentUser'
import { isStaff } from '../auth/schema'
import { getLatestNotice, type Notice } from '../notices/api'
import { ActivityCard } from '../schedule/ActivityCard'
import { todayKey } from '../schedule/order'
import { viewerKey } from '../../lib/queryKeys'
import { useSession } from '../auth/SessionProvider'
import { listSchedule, type ScheduleEntry } from '../schedule/api'

/** How many of the club's next activities the home screen previews — his three. */
const UPCOMING_SHOWN = 3

/**
 * 홈.
 *
 * His home answers three questions before a member has tapped anything: what
 * was announced, what am I in next, and what is coming up (upstream:1252-1262).
 * Ours answered none of them — it was a list of links to other screens, which is
 * a menu, not a home. A member had to open 공지 to find out whether there was a
 * notice at all.
 *
 * So the top of this screen is now the same three answers in the same order, and
 * the links that survive underneath are only the ones nothing else reaches. 공지
 * and 일정 and 마이페이지 are in the bottom nav; 기록, 출석, 이벤트, 알림 설정 and
 * 나의 대회 신청 내역 are on 마이페이지 under 내 메뉴. Repeating all of them here
 * made the screen long enough to push the one thing on it that was not a link
 * below the fold.
 *
 * 채팅, 사진·영상 and 자료실 stay, because they are reachable from nowhere else —
 * /media and /files in particular were routed but unlinked, so the only way to
 * either was to type the URL.
 *
 * Not carried over from his: 지금 뜨는 콘텐츠 / MONTHLY ACTIVITY. That card is
 * static markup in his file — `homeActivitySummary` is written once at
 * upstream:1262 and no script ever touches it — so it prints 0회 and 0% to every
 * member forever, and the 월간 활동 요약 screen it links to has no counterpart
 * here yet. Reproducing a card that always lies is not parity.
 */
export function HomePage() {
  const { user } = useCurrentUser()
  const { session } = useSession()
  const staff = isStaff(user)

  const noticeQuery = useQuery({ queryKey: ['notice-latest'], queryFn: getLatestNotice })

  // The same query key 일정's 전체 tab uses, deliberately: whichever screen a
  // member opens first pays for the fetch and the other is instant, and the two
  // can never disagree about who holds a seat.
  // Carries `mine`, so it is the viewer's answer too. Viewer last, because
  // every invalidation of this uses the bare ['schedule'].
  const scheduleQuery = useQuery({
    queryKey: viewerKey(['schedule', 'all'], session?.user.id),
    queryFn: () => listSchedule(),
  })

  // listSchedule returns a 30-day tail of past activities after the upcoming
  // ones (sortUpcomingFirst), and neither section here wants them: "다가오는"
  // means what it says, and an activity a member attended last week is not the
  // one they need reminding about.
  const rows = scheduleQuery.data
  const upcoming = rows?.filter((entry) => entry.activity.activity_date >= todayKey())
  // Already sorted nearest-first, so the first match is the next one.
  const nextMine =
    upcoming === undefined ? undefined : (upcoming.find((entry) => entry.mine !== null) ?? null)

  return (
    <div className="page">
      <h1 className="title">안녕하세요, {user?.nickname}님</h1>

      <AsyncSection
        query={noticeQuery}
        loading={<Shimmer rows={1} />}
        error="공지를 불러오지 못했습니다"
      >
        {(notice) => <NoticeHero notice={notice} />}
      </AsyncSection>

      <div className="section">
        <h2>내가 참여하는 다음 일정</h2>
      </div>
      <AsyncSection
        query={{ ...scheduleQuery, data: nextMine }}
        loading={<Shimmer rows={1} />}
        isEmpty={(entry) => entry === null}
        empty="현재 신청한 다음 일정이 없어요"
        error="일정을 불러오지 못했습니다"
      >
        {(entry) => entry && <ActivityCard entry={entry} dimmed={false} />}
      </AsyncSection>

      <div className="section">
        <h2>다가오는 일정</h2>
        <Link to="/schedule" className="link">
          전체보기
        </Link>
      </div>
      <AsyncSection
        query={{ ...scheduleQuery, data: upcoming }}
        loading={<Shimmer rows={2} />}
        isEmpty={(entries) => entries.length === 0}
        empty="다가오는 일정이 없어요"
        error="일정을 불러오지 못했습니다"
      >
        {(entries) => <UpcomingList entries={entries} />}
      </AsyncSection>

      <div className="section">
        <h2>바로가기</h2>
      </div>
      <nav className="list" aria-label="바로가기">
        {/* His drawer files 자유게시판 under 게시판 beside 공지
            (upstream:1421). We have no drawer and the bottom nav has five fixed
            destinations, so this tile is the only way to the board — the same
            reason 사진·영상 and 자료실 are here. */}
        <Tile to="/board" icon="✎" title="자유게시판" desc="회원 누구나 쓰는 게시판" />
        <Tile to="/chat" icon="✉" title="채팅" desc="단체 대화와 1:1 메시지" />
        <Tile to="/media" icon="▦" title="사진·영상" desc="폴더별 훈련·대회 기록" />
        <Tile to="/files" icon="▤" title="자료실" desc="폴더에 담기지 않은 파일" />
      </nav>

      {/* 운영 전용. A separate section rather than four more rows in the list
          above, because a staffer reading their own screen should be able to see
          where their own menu ends and the club's management begins. It is also
          the only way to these four: his app hides them behind a drawer we do
          not have, and the bottom nav has five fixed destinations. */}
      {staff && (
        <>
          <div className="section">
            <h2>운영</h2>
          </div>
          <nav className="list" aria-label="운영 메뉴">
            <Tile to="/admin/attendance" icon="◎" title="출석 관리" desc="일정별 출석 체크" />
            <Tile
              to="/admin/applications"
              icon="▥"
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
    </div>
  )
}

/**
 * The dark card at the top — his .hero, and the club reads it as "what is new".
 *
 * A link when there is a notice and a plain div when there is not, rather than a
 * link that goes nowhere: a card that highlights under the thumb and then does
 * nothing is worse than one that never offered.
 */
function NoticeHero({ notice }: { notice: Notice | null }) {
  if (!notice) {
    return (
      <div className="hero">
        <small>LATEST NOTICE</small>
        <h2>등록된 공지가 없습니다</h2>
        <p>새 공지가 등록되면 여기에 표시됩니다.</p>
      </div>
    )
  }

  // His preview is the first line of the body (upstream:2470). Taking the first
  // non-blank line instead, because a notice that opens with a blank line — a
  // textarea makes that easy — would otherwise preview as nothing at all.
  const preview = notice.body.split('\n').find((line) => line.trim() !== '') ?? ''

  return (
    <Link to={`/notices/${notice.id}`} className="hero">
      <small>LATEST NOTICE</small>
      <h2>{notice.title}</h2>
      {preview && <p>{preview}</p>}
    </Link>
  )
}

function UpcomingList({ entries }: { entries: ScheduleEntry[] }) {
  return (
    <ul className="list">
      {entries.slice(0, UPCOMING_SHOWN).map((entry) => (
        <li key={entry.activity.id}>
          <ActivityCard entry={entry} dimmed={false} />
        </li>
      ))}
    </ul>
  )
}

function Tile({ to, icon, title, desc }: { to: string; icon: string; title: string; desc: string }) {
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
