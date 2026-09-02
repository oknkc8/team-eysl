import { supabase } from '../../lib/supabase'

/**
 * 공지 투표 — the client half of 0055.
 *
 * WHY THE RPC CALLS ARE CAST. `supabase` is typed against `src/types/database.ts`,
 * which is generated from the LIVE schema. 0055 has not been applied yet — the
 * lead applies migrations — so none of these five function names exist in that
 * file and `supabase.rpc('save_notice_poll_v1', …)` does not compile. The cast
 * is confined to `pollRpc` below, one call site, so that when the migration
 * lands and `npm run db:types` runs, deleting the shim is the whole of the
 * cleanup. database.ts is not edited here on purpose: it is outside this
 * branch's scope and three other branches are in flight against it.
 *
 * (After regenerating, the two standing checks from CLAUDE.md still apply —
 * whether `member_link_summary_v1` came back, and whether any nullable
 * parameter lost its `| null`.)
 */

export type PollOptionKind = 'text' | 'date'

export type PollOption = {
  id: string
  label: string
  /** Votes on this option, counted from the vote table by the RPC. */
  count: number
  /**
   * Who voted for it, or null when the poll is anonymous.
   *
   * NULL AND EMPTY ARRAY ARE DIFFERENT and the difference is the whole feature:
   * `[]` says nobody voted, `null` says we are not answering. A screen that
   * collapses the two prints "아직 아무도 투표하지 않았어요" over an anonymous
   * poll with nine votes in it.
   *
   * A name can also be missing from a non-anonymous poll's list: the RPC reads
   * names through member_public_v, which shows approved members only, so a
   * voter who was later blocked still counts and is no longer nameable.
   */
  voters: string[] | null
}

export type Poll = {
  id: string
  notice_id: string
  title: string
  option_kind: PollOptionKind
  allow_multiple: boolean
  anonymous: boolean
  allow_option_add: boolean
  closes_at: string | null
  /** The server's own verdict, taken under a row lock at the moment it answered. */
  is_closed: boolean
  total_voters: number
  can_manage: boolean
  can_add_option: boolean
  options: PollOption[]
  /** The caller's own choices. Present for an anonymous poll too — see 0055. */
  my_option_ids: string[]
}

/** What the composer sends. `id` is present for an option already on the poll. */
export type PollDraftOption = { id?: string; label: string }

export type PollDraft = {
  title: string
  option_kind: PollOptionKind
  options: PollDraftOption[]
  allow_multiple: boolean
  anonymous: boolean
  allow_option_add: boolean
  /** ISO 8601, or null for 종료시간 없음. */
  closes_at: string | null
}

// ---------------------------------------------------------------- the shim
/**
 * The one place the untyped RPC names live. Delete this when database.ts knows
 * about them; every caller below is already written as if it were typed.
 */
type PollRpcName =
  | 'get_notice_poll_v1'
  | 'save_notice_poll_v1'
  | 'cast_notice_poll_vote_v1'
  | 'add_notice_poll_option_v1'
  | 'delete_notice_poll_v1'

async function pollRpc(name: PollRpcName, args: Record<string, unknown>): Promise<unknown> {
  const client = supabase as unknown as {
    rpc(fn: string, params: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>
  }
  const { data, error } = await client.rpc(name, args)
  if (error) throw error
  return data
}

// ------------------------------------------------------------ parsing rules
/**
 * PURE, AND OUT HERE SO A TEST CAN REACH IT.
 *
 * THE ANONYMITY RULE IS ENFORCED TWICE, and this is the second time. 0055's
 * get_notice_poll_v1 already returns `voters: null` for an anonymous poll, and
 * that is the enforcement — the database is the only place a rule about who may
 * see what can actually hold. This function refuses to surface names on a poll
 * flagged anonymous ANYWAY, so that the screen cannot print an identity that
 * arrived from a payload it should never have received: an older deployed
 * version of the RPC, a hand-rolled response in a test, a proxy that rewrote
 * the body. Belt and braces, and the braces are the cheap half.
 *
 * It is deliberately not "trust the server's null". `voters` being null is what
 * a correct server sends; `anonymous` being true is what the poll IS.
 */
export function toPoll(raw: unknown): Poll | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>

  const id = typeof row.id === 'string' ? row.id : null
  const noticeId = typeof row.notice_id === 'string' ? row.notice_id : null
  if (!id || !noticeId) return null

  const anonymous = row.anonymous === true
  const optionKind: PollOptionKind = row.option_kind === 'date' ? 'date' : 'text'

  const options = Array.isArray(row.options)
    ? row.options.flatMap((value) => {
        const parsed = toPollOption(value, anonymous)
        return parsed ? [parsed] : []
      })
    : []

  return {
    id,
    notice_id: noticeId,
    title: typeof row.title === 'string' ? row.title : '',
    option_kind: optionKind,
    allow_multiple: row.allow_multiple === true,
    anonymous,
    allow_option_add: row.allow_option_add === true,
    closes_at: typeof row.closes_at === 'string' ? row.closes_at : null,
    is_closed: row.is_closed === true,
    total_voters: typeof row.total_voters === 'number' ? row.total_voters : 0,
    can_manage: row.can_manage === true,
    can_add_option: row.can_add_option === true,
    options,
    my_option_ids: Array.isArray(row.my_option_ids)
      ? row.my_option_ids.filter((value): value is string => typeof value === 'string')
      : [],
  }
}

function toPollOption(value: unknown, anonymous: boolean): PollOption | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const id = typeof row.id === 'string' ? row.id : null
  if (!id) return null

  return {
    id,
    label: typeof row.label === 'string' ? row.label : '',
    count: typeof row.count === 'number' ? row.count : 0,
    // The rule. An anonymous poll has no voter list here whatever arrived.
    voters: anonymous
      ? null
      : Array.isArray(row.voters)
        ? row.voters.filter((name): name is string => typeof name === 'string')
        : null,
  }
}

/**
 * Whether the poll has closed, decided the way 0055 decides it.
 *
 * A MIRROR OF THE DATABASE RULE, NOT THE RULE. cast_notice_poll_vote_v1 takes a
 * row lock and compares closes_at to the server's now(); this compares it to the
 * phone's clock, which can be wrong by any amount and which the member can set.
 * So this decides whether to DRAW the vote control, and the database decides
 * whether a vote counts. They will disagree at the boundary — a member whose
 * clock is a minute slow sees the button and gets 마감된 투표입니다 — and that
 * is the correct way round: the screen is permissive, the database is not.
 *
 * `<=`, not `<`, and null means never closes: both match the SQL exactly.
 *
 * `now` is a parameter rather than a call to Date.now() inside, so a test can
 * put the clock on either side of the deadline without faking timers.
 */
export function isPollClosed(
  poll: Pick<Poll, 'closes_at'>,
  now: Date = new Date(),
): boolean {
  if (!poll.closes_at) return false
  const closesAt = Date.parse(poll.closes_at)
  // An unparseable deadline is treated as no deadline. The alternative — closing
  // the poll — would hide the control over a value the server may be reading
  // perfectly well, and the server refuses the vote either way if it really has
  // closed. Failing open on the SCREEN is safe precisely because the database
  // does not.
  if (Number.isNaN(closesAt)) return false
  return closesAt <= now.getTime()
}

/**
 * Whether to offer the vote control at all.
 *
 * Two sources, and both matter. `is_closed` is the server's verdict at the
 * moment it answered, which is authoritative and immediately stale; the local
 * comparison is what closes the poll on a screen somebody left open past the
 * deadline without a refetch. Either one closing it closes it.
 */
export function canVote(poll: Poll, now: Date = new Date()): boolean {
  return !poll.is_closed && !isPollClosed(poll, now)
}

/**
 * The names to print under an option, or null to print nothing.
 *
 * Null and empty are kept apart here as well: `[]` is a non-anonymous option
 * nobody has chosen, and the caller draws nothing for it because a blank line is
 * not information. An anonymous poll returns null and the caller must never ask
 * again by another route.
 */
export function votersFor(poll: Poll, option: PollOption): string[] | null {
  if (poll.anonymous) return null
  if (!option.voters || option.voters.length === 0) return null
  return option.voters
}

/** Ticking an option, honouring 복수선택. Single-choice replaces; multi toggles. */
export function nextSelection(
  current: readonly string[],
  optionId: string,
  allowMultiple: boolean,
): string[] {
  if (!allowMultiple) {
    // Tapping the chosen option again clears it, so a single-choice poll can be
    // un-voted without a separate control.
    return current.includes(optionId) ? [] : [optionId]
  }
  return current.includes(optionId)
    ? current.filter((id) => id !== optionId)
    : [...current, optionId]
}

/** `2026-09-04` → `2026. 9. 4.`, as his displayLabel does. Text kinds pass through. */
export function formatOptionLabel(label: string, kind: PollOptionKind): string {
  if (kind !== 'date') return label
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(label)
  if (!match) return label
  return `${Number(match[1])}. ${Number(match[2])}. ${Number(match[3])}.`
}

/** 마감 9. 4. 오후 8:00, or 종료시간 없음. */
export function formatDeadline(closesAt: string | null): string {
  if (!closesAt) return '종료시간 없음'
  const at = new Date(closesAt)
  if (Number.isNaN(at.getTime())) return '종료시간 없음'
  return `마감 ${at.toLocaleString('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })}`
}

/** A `datetime-local` value → ISO, or null for an empty box. Invalid input throws. */
export function deadlineToIso(localValue: string): string | null {
  if (!localValue) return null
  const at = new Date(localValue)
  if (Number.isNaN(at.getTime())) {
    throw new Error('투표 종료시간을 확인해주세요')
  }
  return at.toISOString()
}

/** ISO → the value a `datetime-local` input wants, in the viewer's own zone. */
export function isoToDeadlineInput(iso: string | null): string {
  if (!iso) return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`
}

// ------------------------------------------------------------------- calls
/** The poll on a notice, or null when it has none. */
export async function getPoll(noticeId: string): Promise<Poll | null> {
  return toPoll(await pollRpc('get_notice_poll_v1', { p_notice_id: noticeId }))
}

/**
 * Create or replace the poll on a notice.
 *
 * `options` IS THE FINAL LIST, not a delta — an option left out is deleted and
 * its votes go with it. The composer therefore has to send back every option it
 * means to keep, with its id, which is why PollDraftOption carries one.
 */
export async function savePoll(noticeId: string, draft: PollDraft): Promise<Poll | null> {
  return toPoll(
    await pollRpc('save_notice_poll_v1', {
      p_notice_id: noticeId,
      p_title: draft.title,
      p_option_kind: draft.option_kind,
      p_options: draft.options.map((option) =>
        option.id ? { id: option.id, label: option.label } : { label: option.label },
      ),
      p_allow_multiple: draft.allow_multiple,
      p_anonymous: draft.anonymous,
      p_allow_option_add: draft.allow_option_add,
      p_closes_at: draft.closes_at,
    }),
  )
}

/**
 * Replace the caller's whole ballot. An empty array is 투표 취소.
 *
 * The poll comes back from the same call, so the screen redraws from the server's
 * counts rather than incrementing its own copy — which is how the legacy comment
 * list lost writes that landed in the same second.
 */
export async function castVote(pollId: string, optionIds: string[]): Promise<Poll | null> {
  return toPoll(
    await pollRpc('cast_notice_poll_vote_v1', { p_poll_id: pollId, p_option_ids: optionIds }),
  )
}

export async function addPollOption(pollId: string, label: string): Promise<Poll | null> {
  return toPoll(await pollRpc('add_notice_poll_option_v1', { p_poll_id: pollId, p_label: label }))
}

export async function deletePoll(noticeId: string): Promise<void> {
  await pollRpc('delete_notice_poll_v1', { p_notice_id: noticeId })
}
