import { supabase } from '../../lib/supabase'
import {
  personalBests,
  raceEvents,
  relayRecords,
  withDeltas,
  type RaceEvent,
  type WithDelta,
} from './derive'
import type { Json } from '../../types/database'
import { recordSheetObjectPath } from '../media/path'
import type { RosterEntry } from './parser'

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

/**
 * One member's records, and whether this viewer was entitled to them.
 *
 * The flag is the point. `records_read` (0004:222-224) is
 * `member_id = current_member_id() or can_manage_records()`, and a viewer it
 * refuses gets an empty result rather than an error — which renders as "이
 * 회원은 기록이 없습니다" and is a lie. Separating the two lets the screen say
 * 권한이 없습니다 when that is what happened.
 */
export type MemberRecordsView = {
  allowed: boolean
  /** Always empty when `allowed` is false — never a partial list shown as whole. */
  records: SwimRecord[]
}

/**
 * Ask the database the same question its policy asks, rather than guessing from
 * the session.
 *
 * `can_manage_records()` (0004:159-169) admits an admin, a master admin **and**
 * any approved member whose `team_role` is '코치'. `CurrentUser`
 * (auth/schema.ts) carries no team_role at all, so no client-side mirror of that
 * predicate can be written — a coach would be told they lack a right the server
 * would have granted them. One extra round trip buys an answer that agrees with
 * RLS by construction; both helpers are granted to `authenticated` (0002:37,
 * 0004:388).
 *
 * The self case is checked here too, because the policy checks it: a member
 * opening their own detail page must see their own records whatever their role.
 */
export async function getMemberRecords(memberId: string): Promise<MemberRecordsView> {
  const [mine, manages] = await Promise.all([
    supabase.rpc('current_member_id'),
    supabase.rpc('can_manage_records'),
  ])
  if (mine.error) throw mine.error
  if (manages.error) throw manages.error

  const allowed = manages.data === true || (mine.data !== null && mine.data === memberId)
  if (!allowed) return { allowed: false, records: [] }

  return { allowed: true, records: await listRecords(memberId) }
}

/**
 * 대회 참가 현황 — the meets this member swam at.
 *
 * Carries the same `allowed` flag as `getMemberRecords`, for the same reason:
 * an entitled viewer looking at somebody who has never raced and an unentitled
 * viewer must not read the same screen. The grouping itself is `raceEvents`
 * in derive.ts, where it can be tested without a database.
 */
export async function getMemberRaceEvents(memberId: string): Promise<{
  allowed: boolean
  events: RaceEvent[]
}> {
  const view = await getMemberRecords(memberId)
  if (!view.allowed) return { allowed: false, events: [] }
  return { allowed: true, events: raceEvents(view.records) }
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

/**
 * Everyone a parsed 실명 can be matched against.
 *
 * Off `members`, not `member_public_v`: the view carries no real_name, and
 * matching a meet sheet is the one place this app needs one. members_read
 * (0001:173-175) is `auth_user_id = auth.uid() or is_staff()`, so a non-staff
 * caller gets their own row and this list collapses to nothing — the same
 * shape of protection the approval queue relies on.
 *
 * Approved only, and only members who have a 실명 on file. The legacy applied
 * exactly these two filters (index.html:2819-2826) and it still holds: a
 * pending or blocked member is not somebody a meet result should attach to,
 * and a member with no 실명 can never match anything anyway.
 */
export async function listMatchRoster(): Promise<RosterEntry[]> {
  const { data, error } = await supabase
    .from('members')
    .select('id, nickname, real_name')
    .eq('status', 'approved')
    .order('nickname', { ascending: true })
  if (error) throw error

  const roster: RosterEntry[] = []
  for (const row of data ?? []) {
    const realName = (row.real_name ?? '').replace(/\s+/g, ' ').trim()
    if (!realName) continue
    roster.push({ memberId: row.id, nickname: row.nickname, realName })
  }
  return roster
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
 *
 * `metadata` is the only thing that differs between a typed record and a parsed
 * one, so it is the only parameter the two entry points below disagree about.
 */
async function upsertRecord(
  input: RecordInput,
  metadata: Json,
  uploadId?: string,
): Promise<SwimRecord> {
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
    p_metadata: metadata,
    // Omitted rather than sent as null when there is no upload: the SQL
    // parameter defaults to null, and the generated types reject an explicit
    // one — the same reason attendance_my_history_v1 is called with {}.
    ...(uploadId ? { p_upload_id: uploadId } : {}),
  })
  if (error) throw error
  return toRecord(data)
}

/** A result somebody typed on 기록 추가. */
export async function createRecord(input: RecordInput): Promise<SwimRecord> {
  // Marks the row as hand-entered — what separates a result somebody typed from
  // one a file produced, worth having when a parsed row and a typed row
  // disagree.
  return upsertRecord(input, { source: 'manual' })
}

/** Where a parsed row came from, kept so a wrong import can be traced back. */
export type SheetSource = {
  fileName: string
  sheetName: string
  /** 1-based, the row number Excel shows. */
  rowNumber: number
}

/**
 * A result a meet sheet produced, filed after a person confirmed it.
 *
 * The provenance is the point: `source: 'sheet'` plus the file, sheet and row
 * means a record that turns out to be wrong can be traced back to the cell it
 * was read from, rather than being an unexplained number on somebody's profile.
 * The legacy stored the same three things (index.html:2891).
 */
export async function createRecordFromSheet(
  input: RecordInput,
  source: SheetSource,
  uploadId?: string,
): Promise<SwimRecord> {
  return upsertRecord(
    input,
    {
      source: 'sheet',
      source_file: source.fileName,
      source_sheet: source.sheetName,
      source_row: source.rowNumber,
      team: 'EYSL',
      imported_at: new Date().toISOString(),
    },
    uploadId,
  )
}

// --------------------------------------------------------- 결과지 (result sheets)

const SHEET_BUCKET = 'team-files'

/** One uploaded meet sheet. The records filed from it hang off its id. */
export type RecordUpload = {
  id: string
  fileName: string
  storagePath: string
  mimeType: string
  category: RecordCategory
  note: string | null
  uploadedBy: string
  createdAt: string
}

const UPLOAD_COLUMNS =
  'id, file_name, storage_path, mime_type, category, note, uploaded_by, created_at'

function toUpload(row: {
  id: string
  file_name: string
  storage_path: string
  mime_type: string
  category: string
  note: string | null
  uploaded_by: string
  created_at: string
}): RecordUpload {
  return {
    id: row.id,
    fileName: row.file_name,
    storagePath: row.storage_path,
    mimeType: row.mime_type,
    category: row.category as RecordCategory,
    note: row.note,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at,
  }
}

/**
 * Every sheet on file, newest first. A direct select rather than an RPC:
 * record_uploads has had all four RLS policies since 0004 and every one of them
 * is `can_manage_records()`, so a member who may not manage records gets an
 * empty list rather than an error.
 */
export async function listRecordUploads(): Promise<RecordUpload[]> {
  const { data, error } = await supabase
    .from('record_uploads')
    .select(UPLOAD_COLUMNS)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []).map(toUpload)
}

/**
 * File the sheet itself, then put the bytes where the row says they are.
 *
 * ROW FIRST, THEN OBJECT, and the order is forced rather than chosen:
 * team_files_insert asks `media_object_is_claimed(name)` (0021, widened by
 * 0043), so an object whose row does not exist yet is refused by the database.
 *
 * A row with no object is therefore the accepted failure, the same trade the
 * media upload and the notice attachments make. It shows in 결과지 목록 as an
 * entry whose file will not open, which the uploader can see and delete — where
 * an object with no row would be debris nothing points at, invisible to
 * everyone and reachable only by the deletion sweep.
 */
export async function createRecordUpload(input: {
  file: File
  category: RecordCategory
  note?: string
}): Promise<RecordUpload> {
  // Asked of the server rather than threaded down from the screen, the same
  // way media/api.ts does it and for the same reason: this id is the first
  // segment of the object path, so getting it wrong fails the storage policy
  // instead of silently filing the sheet under somebody else.
  const { data: memberId, error: whoami } = await supabase.rpc('current_member_id')
  if (whoami) throw whoami
  if (!memberId) throw new Error('승인된 회원이 아닙니다')

  const storagePath = recordSheetObjectPath({
    memberId,
    fileName: input.file.name,
  })
  const mimeType = input.file.type || 'application/octet-stream'

  const { data, error } = await supabase
    .from('record_uploads')
    .insert({
      file_name: input.file.name,
      storage_path: storagePath,
      mime_type: mimeType,
      category: input.category,
      note: input.note?.trim() ? input.note.trim() : null,
      uploaded_by: memberId,
    })
    .select(UPLOAD_COLUMNS)
    .single()
  if (error) throw error

  const stored = await supabase.storage
    .from(SHEET_BUCKET)
    // upsert:false so a key collision fails loudly instead of replacing
    // somebody's sheet — see the uniqueness note in media/path.ts.
    .upload(storagePath, input.file, { upsert: false, contentType: mimeType })
  if (stored.error) throw stored.error

  return toUpload(data)
}

/**
 * Remove a sheet, and every record filed from it goes with it.
 *
 * The cascade is `records.upload_id references record_uploads(id) on delete
 * cascade` (0004) — the FK that has sat unused because nothing ever set
 * upload_id. This is the undo a bad import has never had.
 *
 * The object is not deleted here, and must not be: 0040's trigger queues it in
 * pending_object_deletions and the sweep is what removes it. Deleting it from
 * the client would race that queue.
 */
export async function deleteRecordUpload(uploadId: string): Promise<void> {
  const { error } = await supabase.from('record_uploads').delete().eq('id', uploadId)
  if (error) throw error
}

/** How many records a sheet produced — what 삭제 is about to take with it. */
export async function countRecordsFromUpload(uploadId: string): Promise<number> {
  const { count, error } = await supabase
    .from('records')
    .select('id', { count: 'exact', head: true })
    .eq('upload_id', uploadId)
  if (error) throw error
  return count ?? 0
}
