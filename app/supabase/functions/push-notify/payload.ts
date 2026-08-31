/**
 * What a notification says.
 *
 * Separated from everything else in this function because it is the part with no
 * I/O in it: given the facts the database returned, this decides the Korean the
 * member reads on their lock screen. That makes it the part worth testing, and
 * payload.test.ts runs under the app's vitest suite rather than under Deno —
 * there is nothing here for Deno to provide.
 *
 * The shape is the legacy sender's — { title, body, icon, badge, tag, url } —
 * because src/sw.js was ported from the legacy worker to that contract (see its
 * `push` listener) and the club's existing installs already expect it. Changing
 * it would mean changing the worker, and the worker is the half that worked.
 */

/** The events this function knows how to describe. */
export type PushEvent =
  | 'notice_created'
  | 'activity_created'
  | 'waitlist_offered'
  | 'activity_comment_created'
  | 'self_test'

/**
 * What src/sw.js reads out of `event.data.json()`.
 *
 * `url` is resolved against our own origin by the worker before it navigates, so
 * a value here can only ever move the member around this app.
 */
export type PushPayload = {
  title: string
  body: string
  icon: string
  badge: string
  tag: string
  url: string
}

/**
 * The facts, exactly as push_notify_context_v1() returns them.
 *
 * Read from the row by the database rather than accepted from whoever asked for
 * the send — a caller that could supply the text could put any sentence in front
 * of the whole club under the club's own name.
 */
export type NoticeFact = { notice_id: string; title: string }
export type ActivityFact = {
  activity_id: string
  kind: string
  title: string
  activity_date: string
  start_time: string | null
}
export type OfferFact = {
  activity_id: string
  kind: string
  title: string
  activity_date: string
  /** ISO 8601, and the reason this notification is urgent rather than pleasant. */
  offer_expires_at: string
}

/** A comment landed on a training/race/기타. Recipients are that activity's own applicants and waitlisters (0050), never the whole club. */
export type CommentFact = {
  activity_id: string
  kind: string
  title: string
  activity_date: string
  /** Free text, unlike a notice's title — truncated for the lock screen below. */
  body: string
}

const ICON = '/icon-192.png'

// 'event' reads 기타 rather than 이벤트: the president relabelled this kind and
// gave 이벤트 to the rankings hub. Same table as src/features/schedule/kinds.ts,
// duplicated rather than imported — this function is deployed on its own and
// must not reach into the browser bundle's source tree to render a caption.
const KIND_LABEL: Record<string, string> = {
  training: '훈련',
  race: '대회',
  event: '기타',
}

function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? '일정'
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const

/**
 * `2026-09-01` → `9월 1일(화)`.
 *
 * Split by hand rather than handed to Date, because activities.activity_date is
 * a `date` — a calendar day with no instant behind it. `new Date('2026-09-01')`
 * invents UTC midnight for it, and formatting that anywhere west of Greenwich
 * silently prints the day before. The weekday still needs a Date, so it is built
 * as UTC noon, which no timezone offset can push into an adjacent day.
 */
export function formatActivityDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim())
  if (!match) return isoDate
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])

  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay()] ?? ''
  return `${month}월 ${day}일(${weekday})`
}

/** `18:30:00` → `18:30`. Seconds are noise on a lock screen. */
export function formatStartTime(time: string | null): string {
  if (!time) return ''
  const match = /^(\d{2}):(\d{2})/.exec(time.trim())
  return match ? `${match[1]}:${match[2]}` : time
}

/**
 * When an offer runs out, in the club's own timezone.
 *
 * Asia/Seoul is named rather than inherited: this runs on Supabase's servers,
 * whose clock is UTC, and a deadline printed in UTC is nine hours early — which
 * on a twelve-hour offer is most of it. The club is in Korea; the deadline is
 * stated in Korea's time whatever the sender's.
 */
export function formatDeadline(isoTimestamp: string): string {
  const at = new Date(isoTimestamp)
  if (Number.isNaN(at.getTime())) return ''

  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at)

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? ''

  return `${get('month')}월 ${get('day')}일 ${get('hour')}:${get('minute')}`
}

/**
 * A new notice was posted.
 *
 * The notice's own title is the body: it is already the one line the author
 * wrote to summarise it, so anything else would be a worse summary of the same
 * thing. The notice body is deliberately left out — a notice can run long, and a
 * lock screen is not where it should be read.
 */
export function noticePayload(fact: NoticeFact): PushPayload {
  return {
    title: 'TEAM EYSL 새 공지',
    body: fact.title,
    icon: ICON,
    badge: ICON,
    // Keyed to the notice so a resend replaces the old notification instead of
    // stacking a second copy of the same news.
    tag: `notice-${fact.notice_id}`,
    url: `/notices/${fact.notice_id}`,
  }
}

/** A new training, race or 기타 was filed. */
export function activityPayload(fact: ActivityFact): PushPayload {
  const day = formatActivityDate(fact.activity_date)
  const time = formatStartTime(fact.start_time)

  return {
    title: `TEAM EYSL 새 ${kindLabel(fact.kind)}`,
    body: `${time ? `${day} ${time}` : day} · ${fact.title}`,
    icon: ICON,
    badge: ICON,
    tag: `activity-${fact.activity_id}`,
    url: `/schedule/${fact.activity_id}`,
  }
}

/**
 * A waitlist offer reached someone. The one notification here that is load-bearing.
 *
 * Two things this says that the others do not need to. The deadline, because the
 * offer expires — sweep_stale_offers() (0020) hands the seat to the next person
 * in line twelve hours later, and a member who never learned they had it loses it
 * to someone who did. And a URL that lands on the activity rather than the home
 * screen, because /schedule/:activityId is where the 수락 button is
 * (ActivityDetailPage). Waking someone before the deadline and then making them
 * go looking for the button is how a seat is lost with the notification working.
 */
export function offerPayload(fact: OfferFact): PushPayload {
  const deadline = formatDeadline(fact.offer_expires_at)
  // The kind goes in the heading rather than into the sentence, because most
  // titles already contain it: "자유형 강화 훈련" plus a 훈련 label reads
  // "자유형 강화 훈련 훈련에". Above the body it still tells a member what kind
  // of thing they have been offered a place at, without ever doubling up.
  const tail = deadline ? `${deadline}까지 수락해주세요.` : '서둘러 수락해주세요.'

  return {
    title: `TEAM EYSL ${kindLabel(fact.kind)} 대기 자리가 났어요`,
    body: `${formatActivityDate(fact.activity_date)} ${fact.title} · ${tail}`,
    icon: ICON,
    badge: ICON,
    // Keyed to the activity, not to the application row: a member offered the
    // same seat twice — declined, re-applied, offered again — should see one
    // live notification about it, showing the deadline that is actually current.
    tag: `offer-${fact.activity_id}`,
    url: `/schedule/${fact.activity_id}`,
  }
}

/**
 * `'그동안 고생 많았어요!!!'` → `'그동안 고생 많았어요!!!'` unchanged under the
 * limit, or cut with `…` appended once it is not. A code-point slice (not a
 * byte slice) so it never lands mid-multibyte-character on a Korean string.
 */
export function truncate(text: string, max: number): string {
  const trimmed = text.trim()
  const chars = [...trimmed]
  if (chars.length <= max) return trimmed
  return `${chars.slice(0, max).join('')}…`
}

/**
 * A new comment landed on a training/race/기타.
 *
 * The comment's own text is the body, truncated — the same reasoning as
 * noticePayload using the notice's title: it is already the one line the
 * commenter wrote, so summarising it further would be a worse summary of the
 * same thing. Unlike a notice title, a comment body has no length limit at
 * the schema level, so this is the one payload here that truncates.
 */
export function activityCommentPayload(fact: CommentFact): PushPayload {
  return {
    title: `TEAM EYSL ${kindLabel(fact.kind)} 새 댓글`,
    body: `${fact.title} · ${truncate(fact.body, 60)}`,
    icon: ICON,
    badge: ICON,
    // Keyed to the activity rather than the comment: several comments on one
    // 훈련 in quick succession collapse into the latest, the same way a
    // repeated waitlist offer on the same activity does — one live
    // notification about the thread, not a stack of them.
    tag: `activity-comment-${fact.activity_id}`,
    // Not /notices/:id — this is the schedule detail, where the thread lives.
    url: `/schedule/${fact.activity_id}`,
  }
}

/**
 * The member pressed 테스트 알림 보내기 in 알림 설정.
 *
 * Exists because "registered" and "receiving" are different facts, and until one
 * arrives nobody can tell them apart — which is the state this whole feature was
 * in. The audience is the caller's own devices and nothing else.
 */
export function selfTestPayload(): PushPayload {
  return {
    title: 'TEAM EYSL 알림 테스트',
    body: '이 알림이 보이면 이 기기로 알림이 정상 도착합니다.',
    icon: ICON,
    badge: ICON,
    // A constant, unlike the others: a member pressing the button three times
    // wants to know it still works, not three notifications to dismiss.
    tag: 'push-test',
    url: '/settings/notifications',
  }
}

/** Dispatch on the event name, with the facts the database returned for it. */
export function buildPayload(event: PushEvent, fact: unknown): PushPayload {
  switch (event) {
    case 'notice_created':
      return noticePayload(fact as NoticeFact)
    case 'activity_created':
      return activityPayload(fact as ActivityFact)
    case 'waitlist_offered':
      return offerPayload(fact as OfferFact)
    case 'activity_comment_created':
      return activityCommentPayload(fact as CommentFact)
    case 'self_test':
      return selfTestPayload()
  }
}
