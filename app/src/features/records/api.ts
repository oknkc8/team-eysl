import { supabase } from '../../lib/supabase'
import { personalBests, relayRecords, withDeltas, type WithDelta } from './derive'

export type RecordCategory = 'meet' | 'fin' | 'other'
export type RecordSubcategory = 'personal' | 'relay'

export const RECORD_CATEGORIES: readonly RecordCategory[] = ['meet', 'fin', 'other']
export const RECORD_SUBCATEGORIES: readonly RecordSubcategory[] = ['personal', 'relay']

// Korean is a render-time concern; the database stores English tokens, the same
// split as schedule's KIND_LABEL. The wording is the legacy screen's own
// (index.html:3228) so a member reading the rebuilt page sees what they see now.
export const CATEGORY_LABEL: Record<RecordCategory, string> = {
  meet: '일반 수영대회',
  fin: '핀 수영대회',
  other: '기타',
}

export const SUBCATEGORY_LABEL: Record<RecordSubcategory, string> = {
  personal: '개인전',
  relay: '단체전',
}

// The column is free text on purpose — strokes arrive from parsed meet sheets,
// not from a set this app defines — so these are what the form offers first,
// not what it accepts. Taken from index.html:2562-2566.
export const STROKE_OPTIONS: Record<RecordSubcategory, readonly string[]> = {
  personal: ['자유형', '배영', '평영', '접영', '개인혼영'],
  relay: ['계영', '혼계영', '혼성계영', '혼성혼계영'],
}

export type SwimRecord = {
  id: string
  member_id: string
  category: RecordCategory
  subcategory: RecordSubcategory
  stroke: string
  distance_m: number
  event_name: string
  event_date: string
  /** What the parser or the person entering it read off the sheet. */
  result_display: string
  /** Canonical. Every comparison on this screen reads this, never the string. */
  result_centiseconds: number
  teammates: string[]
  created_at: string
}

export type RecordHistoryRow = WithDelta<SwimRecord>

export type MyRecords = {
  personalBests: SwimRecord[]
  relays: SwimRecord[]
  history: RecordHistoryRow[]
}

const RECORD_COLUMNS =
  'id, member_id, category, subcategory, stroke, distance_m, event_name, event_date, result_display, result_centiseconds, teammates, created_at'

// Far more than a club swimmer accumulates in a season, and small enough that
// deriving bests in the browser stays cheap.
const HISTORY_LIMIT = 500

// ---------------------------------------------------------------- narrowing
// Both columns are constrained by a CHECK in 0004, but the generated types
// widen them to `string`. Narrowing happens once, here, rather than as a cast
// at each render site.

function toCategory(value: string): RecordCategory {
  return (RECORD_CATEGORIES as readonly string[]).includes(value)
    ? (value as RecordCategory)
    : 'other'
}

// Leans to 'relay' for the same reason schedule's toApplicationType leans to
// 'waitlist': personalBests() excludes relays, so a value this client does not
// understand falling through to 'personal' could hand somebody a best they
// never swam off the blocks. 'relay' is the reading that cannot invent one.
function toSubcategory(value: string): RecordSubcategory {
  return value === 'personal' ? 'personal' : 'relay'
}

type RecordRow = {
  id: string
  member_id: string
  category: string
  subcategory: string
  stroke: string
  distance_m: number
  event_name: string
  event_date: string
  result_display: string
  result_centiseconds: number
  teammates: string[]
  created_at: string
}

const toRecord = (row: RecordRow): SwimRecord => ({
  id: row.id,
  member_id: row.member_id,
  category: toCategory(row.category),
  subcategory: toSubcategory(row.subcategory),
  stroke: row.stroke,
  distance_m: row.distance_m,
  event_name: row.event_name,
  event_date: row.event_date,
  result_display: row.result_display,
  result_centiseconds: row.result_centiseconds,
  teammates: row.teammates,
  created_at: row.created_at,
})

// ------------------------------------------------------------------- reads

// Asked of the server rather than threaded down from the session, and it
// matters here for the same reason it does in schedule: records_read passes
// every row to anyone can_manage_records() accepts, so an unfiltered query
// would hand a coach the whole club's history under the heading 내 기록.
async function getMyMemberId(): Promise<string> {
  const { data, error } = await supabase.rpc('current_member_id')
  if (error) throw error
  if (!data) throw new Error('승인된 회원이 아닙니다')
  return data
}

/** Every record belonging to one member, most recent event first. */
export async function listRecords(memberId: string): Promise<SwimRecord[]> {
  const { data, error } = await supabase
    .from('records')
    .select(RECORD_COLUMNS)
    .eq('member_id', memberId)
    .order('event_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT)
  if (error) throw error
  return (data ?? []).map(toRecord)
}

/**
 * The viewer's own records, in the three shapes the screen needs.
 *
 * One fetch rather than three: RLS narrows a member to their own rows, so bests
 * and relays are subsets of the same set the history is built from, and asking
 * the server separately for each would be three round trips for one answer.
 * The ordering each tab wants is decided in derive.ts.
 */
export async function getMyRecords(): Promise<MyRecords> {
  const memberId = await getMyMemberId()
  const all = await listRecords(memberId)

  return {
    personalBests: personalBests(all),
    relays: relayRecords(all),
    history: withDeltas(all),
  }
}

export type MemberOption = { id: string; nickname: string; short_name: string | null }

/**
 * Everyone a record can be filed against.
 *
 * member_public_v, never members: members_read shows a member only their own
 * row, and the view is already confined to approved members (0001:158-161).
 */
export async function listMemberOptions(): Promise<MemberOption[]> {
  const { data, error } = await supabase
    .from('member_public_v')
    .select('id, nickname, short_name')
    .order('nickname', { ascending: true })
  if (error) throw error

  // Every column of a view is nullable in the generated types, so a row without
  // an id is skipped rather than cast into one.
  const options: MemberOption[] = []
  for (const row of data ?? []) {
    if (!row.id) continue
    options.push({
      id: row.id,
      nickname: row.nickname ?? '이름 없는 회원',
      short_name: row.short_name,
    })
  }
  return options
}

// ------------------------------------------------------------------ writes

export type RecordInput = {
  memberId: string
  category: RecordCategory
  subcategory: RecordSubcategory
  stroke: string
  distanceM: number
  eventName: string
  eventDate: string
  resultDisplay: string
  resultCentiseconds: number
  teammates: string[]
}

/**
 * File a result. Never an insert into records — the table has no write policy
 * at all (0004), and the RPC is what takes the advisory lock that stops two
 * uploads of the same swim from both landing.
 *
 * The returned row is the server's copy, including in the case where the swim
 * was already on file and the insert did nothing.
 */
export async function createRecord(input: RecordInput): Promise<SwimRecord> {
  const { data, error } = await supabase.rpc('upsert_record', {
    p_member_id: input.memberId,
    p_category: input.category,
    // Required, unlike p_event_name and p_teammates: the SQL parameter has no
    // default even though the column does.
    p_subcategory: input.subcategory,
    p_stroke: input.stroke,
    p_distance_m: input.distanceM,
    p_event_date: input.eventDate,
    p_result_display: input.resultDisplay,
    p_result_centiseconds: input.resultCentiseconds,
    p_event_name: input.eventName,
    p_teammates: input.teammates,
    // Marks the row as hand-entered. Once the sheet parser lands this is what
    // separates a result somebody typed from one a file produced — worth having
    // when a parsed row and a typed row disagree.
    p_metadata: { source: 'manual' },
  })
  if (error) throw error
  return toRecord(data)
}
