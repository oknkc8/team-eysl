import { supabase } from '../../lib/supabase'
import type { Half } from './duesMath'

/**
 * 회비 — the client half of 0057.
 *
 * WHY THE RPC CALLS ARE CAST. `supabase` is typed against `src/types/database.ts`,
 * which is generated from the LIVE schema. 0057 has not been applied yet — the
 * lead applies migrations — so none of these thirteen function names exist in
 * that file and `supabase.rpc('my_dues_summary_v1')` does not compile. The cast
 * is confined to `duesRpc` below, one call site, so that when the migration lands
 * and `npm run db:types` runs, deleting the shim is the whole of the cleanup.
 *
 * database.ts is NOT edited here on purpose. It is outside this branch's scope,
 * several branches are in flight against it, and hand-writing entries into a
 * generated file makes the next regeneration look like somebody else's feature
 * broke — which is exactly the failure CLAUDE.md records for `save_notice_v1`.
 * This follows what `notices/pollApi.ts` does for the same reason.
 *
 * (After regenerating, the two standing checks from CLAUDE.md still apply —
 * whether `member_link_summary_v1` came back, and whether any nullable parameter
 * lost its `| null`. `save_dues_period_v1`'s `p_period_id` is one of those: null
 * means "create" and the generator cannot see that a plpgsql parameter is
 * nullable, so it will narrow it to bare `string` and break `saveDuesPeriod`.)
 *
 * NOTE ON WHAT IS ABSENT. There is no `balance` on any row type below and no
 * `collected_amount` on the session list, because 0057 does not return them. See
 * that migration's header: the credit side of the ledger is the club's bank
 * sheet, `scripts/import/parse.ts` excludes it deliberately, and a subtraction
 * without it tells a member who paid that they still owe. Do not add either
 * field here "to save a round trip" — there is nothing to round-trip to.
 */

// ------------------------------------------------------------------- the shim
/** The one place the untyped RPC names live. Delete this when database.ts knows them. */
type DuesRpcName =
  | 'list_dues_periods_v1'
  | 'my_dues_summary_v1'
  | 'my_activity_fees_v1'
  | 'dues_period_roster_v1'
  | 'activity_fee_roster_v1'
  | 'list_activity_fees_v1'
  | 'save_dues_period_v1'
  | 'delete_dues_period_v1'
  | 'set_dues_payment_v1'
  | 'clear_dues_payment_v1'
  | 'set_activity_fee_v1'
  | 'clear_activity_fee_v1'
  | 'set_activity_fee_payment_v1'

async function duesRpc(name: DuesRpcName, args: Record<string, unknown> = {}): Promise<unknown> {
  const client = supabase as unknown as {
    rpc(fn: string, params: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>
  }
  const { data, error } = await client.rpc(name, args)
  // Thrown, not returned, so react-query parks it in `query.error` and
  // AsyncSection renders the failure branch. A swallowed query error looks
  // exactly like a slow network — the getMyMember lockout is this project's
  // standing example of a screen that spins forever on a discarded rejection.
  if (error) throw error
  return data
}

// ------------------------------------------------------------------ row types
// Each mirrors one `returns table` in 0057, column for column and in order.

export type DuesPeriod = {
  period_id: string
  year: number
  half: Half
  amount: number
}

export type MyDuesRow = {
  period_id: string
  year: number
  half: Half
  due_amount: number
  /** What a staffer entered. NOT what the club received — see the header. */
  paid_amount: number
  paid_on: string | null
}

export type MyActivityFeeRow = {
  activity_id: string
  activity_date: string
  title: string
  place: string | null
  fee_amount: number
  paid: boolean
  paid_amount: number
}

export type DuesRosterRow = {
  member_id: string
  nickname: string
  short_name: string | null
  avatar_path: string | null
  due_amount: number
  paid_amount: number
  paid_on: string | null
  note: string | null
}

export type ActivityFeeRosterRow = {
  member_id: string
  nickname: string
  short_name: string | null
  avatar_path: string | null
  fee_amount: number
  paid: boolean
  paid_amount: number
  paid_on: string | null
}

export type ActivityFeeRow = {
  activity_id: string
  activity_date: string
  title: string
  place: string | null
  fee_amount: number
  /** 참여횟수 for this session — a count of entries, not a sum of money. */
  paid_count: number
}

// ---------------------------------------------------------------------- reads

export async function listDuesPeriods(): Promise<DuesPeriod[]> {
  return ((await duesRpc('list_dues_periods_v1')) ?? []) as DuesPeriod[]
}

/** Takes no member id — the server derives the caller from the session. */
export async function getMyDuesSummary(): Promise<MyDuesRow[]> {
  return ((await duesRpc('my_dues_summary_v1')) ?? []) as MyDuesRow[]
}

/** Both bounds default to null server-side, so omitting them asks for everything. */
export async function getMyActivityFees(): Promise<MyActivityFeeRow[]> {
  return ((await duesRpc('my_activity_fees_v1')) ?? []) as MyActivityFeeRow[]
}

/**
 * Staff only. Refuses with 42501 rather than answering empty, so a member who
 * reaches this sees the error branch and not a club where nobody has paid.
 */
export async function getDuesPeriodRoster(periodId: string): Promise<DuesRosterRow[]> {
  return ((await duesRpc('dues_period_roster_v1', { p_period_id: periodId })) ??
    []) as DuesRosterRow[]
}

/** Staff only. Also refuses when the activity has no fee set — a distinct 23503. */
export async function getActivityFeeRoster(activityId: string): Promise<ActivityFeeRosterRow[]> {
  return ((await duesRpc('activity_fee_roster_v1', { p_activity_id: activityId })) ??
    []) as ActivityFeeRosterRow[]
}

/** Staff only. Sessions that have a fee set, with the count of entries per session. */
export async function listActivityFees(): Promise<ActivityFeeRow[]> {
  return ((await duesRpc('list_activity_fees_v1')) ?? []) as ActivityFeeRow[]
}

// --------------------------------------------------------------------- writes

/**
 * `periodId` null means create. It is typed `string | null` rather than
 * `string | undefined` deliberately: the RPC branches on `p_period_id is null`,
 * and omitting the key entirely would let the parameter default instead — a
 * different code path from passing null explicitly.
 */
export async function saveDuesPeriod(input: {
  periodId: string | null
  year: number
  half: Half
  amount: number
}): Promise<string> {
  const id = await duesRpc('save_dues_period_v1', {
    p_period_id: input.periodId,
    p_year: input.year,
    p_half: input.half,
    p_amount: input.amount,
  })
  return id as string
}

/** Cascades the period's payment rows. The screen must confirm before calling. */
export async function deleteDuesPeriod(periodId: string): Promise<void> {
  await duesRpc('delete_dues_period_v1', { p_period_id: periodId })
}

export async function setDuesPayment(input: {
  periodId: string
  memberId: string
  amount: number
  paidOn?: string | null
  note?: string | null
}): Promise<void> {
  await duesRpc('set_dues_payment_v1', {
    p_period_id: input.periodId,
    p_member_id: input.memberId,
    p_amount: input.amount,
    p_paid_on: input.paidOn ?? null,
    p_note: input.note ?? null,
  })
}

/**
 * A DELETE PATH, and load-bearing rather than convenient. Without it a
 * mis-entered figure could only be overwritten, never withdrawn, and the row
 * would keep asserting a payment nobody made. See 0057's header.
 */
export async function clearDuesPayment(input: {
  periodId: string
  memberId: string
}): Promise<void> {
  await duesRpc('clear_dues_payment_v1', {
    p_period_id: input.periodId,
    p_member_id: input.memberId,
  })
}

/** 0 is a valid amount and means the session was free — not the same as clearing. */
export async function setActivityFee(input: {
  activityId: string
  amount: number
}): Promise<void> {
  await duesRpc('set_activity_fee_v1', {
    p_activity_id: input.activityId,
    p_amount: input.amount,
  })
}

/**
 * The other load-bearing delete. Returns a session to "no fee decided", which a
 * fee of 0 does NOT do — 0 says the club decided it was free. Cascades the
 * session's payment rows.
 */
export async function clearActivityFee(activityId: string): Promise<void> {
  await duesRpc('clear_activity_fee_v1', { p_activity_id: activityId })
}

/**
 * A toggle, not an amount. The server copies the session's own fee onto the row,
 * so the client cannot name a price — which is what keeps the two from drifting.
 *
 * `paid: false` is the third delete path: it removes the row rather than writing
 * a zero, so a mis-tap can be taken back.
 */
export async function setActivityFeePayment(input: {
  activityId: string
  memberId: string
  paid: boolean
  paidOn?: string | null
}): Promise<void> {
  await duesRpc('set_activity_fee_payment_v1', {
    p_activity_id: input.activityId,
    p_member_id: input.memberId,
    p_paid: input.paid,
    p_paid_on: input.paidOn ?? null,
  })
}
