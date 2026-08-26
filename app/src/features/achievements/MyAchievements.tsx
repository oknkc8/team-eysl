import { useQuery } from '@tanstack/react-query'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { useSession } from '../auth/SessionProvider'
import { getMyAchievement } from './api'
import {
  ATTENDANCE_BADGES,
  achievementQueryKey,
  badgeMessage,
  badgeProgressLabel,
  badgeYearLabel,
  formatPb,
  isBadgeUnlocked,
  momentEventLabel,
  stablePbMessage,
  type Achievement,
  type PbMoment,
} from './achievements'

/**
 * 나의 출석 배지 and PB 모먼트, the pair he added in final72-my-achievements and
 * refined in final73-badge-reveal. Both come out of one RPC call, so they share
 * one AsyncSection: two would mean two spinners and two failure states for a
 * single request.
 */
export function MyAchievements() {
  const { session } = useSession()
  const query = useQuery({
    queryKey: achievementQueryKey(session?.user.id),
    queryFn: () => getMyAchievement(),
  })

  return (
    <AsyncSection
      query={query}
      loading={<Shimmer rows={2} />}
      error="출석 배지와 PB 모먼트를 불러오지 못했습니다"
    >
      {(data) => <Achievements data={data} />}
    </AsyncSection>
  )
}

function Achievements({ data }: { data: Achievement }) {
  return (
    <>
      <div className="titleRow">
        <h2 className="listDivider">나의 출석 배지</h2>
        <span className="meta">{badgeYearLabel(data.year, data.attendance_count)}</span>
      </div>

      <p className="badgeProgress">{badgeProgressLabel(data.attendance_count)}</p>

      <ul className="badgeGrid">
        {ATTENDANCE_BADGES.map((badge) => {
          const unlocked = isBadgeUnlocked(data.attendance_count, badge)
          return (
            <li key={badge.count} className={unlocked ? 'badge' : 'badge locked'}>
              {/* The icon is decorative — the state is spelled out in the
                  sr-only span below, and announcing it twice is noise. */}
              <span className="badgeIcon" aria-hidden="true">
                {unlocked ? '✓' : '🔒'}
              </span>
              <b>{badge.title}</b>
              <p>{badgeMessage(data.attendance_count, badge)}</p>
              <span className="sr-only">{unlocked ? '달성' : '미달성'}</span>
            </li>
          )
        })}
      </ul>

      <div className="titleRow">
        <h2 className="listDivider">PB 모먼트</h2>
        <span className="meta">내가 깬 기록들 🎉</span>
      </div>

      {data.pb_moments.length === 0 ? (
        <p className="card meta">올해 새로 달성한 PB가 아직 없어요. 첫 PB 모먼트를 만들어봐요! 🏊</p>
      ) : (
        <div className="pbList">
          {data.pb_moments.map((moment) => (
            <PbCard
              // Two moments share a stroke and a date only when they are
              // different distances, so the event goes into the key as well.
              key={`${moment.event_date}-${moment.stroke}-${moment.distance}`}
              moment={moment}
            />
          ))}
        </div>
      )}
    </>
  )
}

function PbCard({ moment }: { moment: PbMoment }) {
  return (
    <article className="pbCard">
      <div className="pbHead">
        <b>🎉 NEW PB · {momentEventLabel(moment)}</b>
        <span>{moment.event_date}</span>
      </div>
      <div className="pbRecord">
        {formatPb(moment.old_pb)} → {formatPb(moment.new_pb)}
      </div>
      <div className="pbDelta">▼ {formatPb(moment.improvement)}초 단축</div>
      <p className="pbMsg">{stablePbMessage(moment)}</p>
      {moment.event_name && <div className="pbEvent">{moment.event_name}</div>}
    </article>
  )
}
