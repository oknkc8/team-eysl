import { Link } from 'react-router'
import { myStatusTag } from './status'
import { formatDateLabel, formatTimeRange } from './order'
import { KIND_LABEL, type ScheduleEntry } from './api'

/**
 * One activity, as the club recognises it: kind, title, whether the viewer is in
 * it, then when and where and how full.
 *
 * Shared by 일정 and by the home screen's two activity sections. Home used to be
 * a menu of links with no activity on it at all; the moment it grew one, the
 * choice was this component or a second, slightly different card that would
 * drift from it. His app made the second choice — his home rows say 신청완료
 * where his list says otherwise, and they carry different fields — and the cost
 * lands on a member who has to work out whether they are looking at the same
 * thing.
 */
export function ActivityCard({ entry, dimmed }: { entry: ScheduleEntry; dimmed: boolean }) {
  const { activity } = entry
  const tag = myStatusTag(entry.mine)
  const time = formatTimeRange(activity.start_time, activity.end_time)

  // A null capacity means the activity is uncapped, not that it holds zero.
  const seats =
    activity.capacity === null
      ? `신청 ${entry.participant_count}명`
      : `신청 ${entry.participant_count}/${activity.capacity}`

  return (
    <Link to={`/schedule/${activity.id}`} className={`card activityCard${dimmed ? ' isPast' : ''}`}>
      <div className="activityHead">
        <span className="tag idle">{KIND_LABEL[activity.kind]}</span>
        <b className="grow">{activity.title}</b>
        {tag && <span className={`tag ${tag.tone}`}>{tag.label}</span>}
      </div>

      <p className="activityMeta">
        <span>{formatDateLabel(activity.activity_date)}</span>
        {time && <span>{time}</span>}
        {activity.place && <span>{activity.place}</span>}
        <span aria-hidden="true">·</span>
        <span>{seats}</span>
        {entry.waitlist_count > 0 && <span>대기 {entry.waitlist_count}</span>}
      </p>
    </Link>
  )
}
