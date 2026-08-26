import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { SaveState } from '../../components/ui/SaveState'
import { formatCentiseconds, parseSwimTime } from './time'
import {
  CATEGORY_LABEL,
  createRecord,
  listMemberOptions,
  RECORD_CATEGORIES,
  RECORD_SUBCATEGORIES,
  STROKE_OPTIONS,
  SUBCATEGORY_LABEL,
  type MemberOption,
  type RecordCategory,
  type RecordInput,
  type RecordSubcategory,
  type SwimRecord,
} from './api'

const CARD = {
  padding: 14,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
} as const

const FIELD = {
  width: '100%',
  boxSizing: 'border-box',
  padding: 12,
  minHeight: 44,
  borderRadius: 13,
  border: '1px solid #e1e5ea',
  fontSize: 14,
  fontFamily: 'inherit',
} as const

const LABEL = { display: 'block', fontSize: 12, color: '#6b7178', marginBottom: 6 } as const

const chip = (selected: boolean) =>
  ({
    minHeight: 44,
    minWidth: 72,
    padding: '0 16px',
    borderRadius: 999,
    border: selected ? '1px solid #111317' : '1px solid #e1e5ea',
    background: selected ? '#111317' : '#fff',
    color: selected ? '#fff' : '#111317',
    fontSize: 13,
  }) as const

// This screen is the whole write side of the slice. The Excel/PDF parser is a
// separate piece of work: the legacy one is ~250 lines of heuristics tuned
// against real Korean meet sheets, and porting it without golden files would
// corrupt records quietly rather than loudly.
export function AdminRecordEditPage() {
  const membersQuery = useQuery({ queryKey: ['member-options'], queryFn: listMemberOptions })

  return (
    <Page title="기록 추가">
      {/* Fetched first and passed down, so the form seeds its state from a prop
          exactly once with no effect syncing a late-arriving list. */}
      <AsyncSection
        query={membersQuery}
        isEmpty={(rows) => rows.length === 0}
        loading={<Shimmer rows={3} />}
        empty="등록된 회원이 없습니다"
        error="회원 목록을 불러오지 못했습니다"
      >
        {(members) => <RecordForm members={members} />}
      </AsyncSection>
    </Page>
  )
}

function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="page">
      <Link to="/records" className="backLink">
        ← 기록
      </Link>
      <h1 style={{ fontSize: 22, letterSpacing: -0.8, margin: '12px 0 16px' }}>{title}</h1>
      {children}
    </div>
  )
}

// Comma separated on the way in, an array on the way out. Empty entries are
// dropped rather than stored, so a trailing comma does not become a nameless
// teammate.
const parseTeammates = (value: string) =>
  value
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')

function RecordForm({ members }: { members: MemberOption[] }) {
  const qc = useQueryClient()

  const [memberId, setMemberId] = useState('')
  const [category, setCategory] = useState<RecordCategory>('meet')
  const [subcategory, setSubcategory] = useState<RecordSubcategory>('personal')
  const [stroke, setStroke] = useState('')
  // Kept as text so an empty box stays empty rather than collapsing to 0, which
  // the distance_m > 0 CHECK would reject anyway.
  const [distance, setDistance] = useState('')
  const [eventName, setEventName] = useState('')
  const [eventDate, setEventDate] = useState('')
  const [time, setTime] = useState('')
  const [teammates, setTeammates] = useState('')
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  // Proof the write landed, and the running list a coach needs when entering a
  // whole heat one row at a time.
  const [saved, setSaved] = useState<SwimRecord[]>([])

  const save = useMutation({
    mutationFn: (input: RecordInput) => createRecord(input),
    onMutate: () => setState('saving'),
    onSuccess: async (record) => {
      setState('saved')
      // Filed twice, upsert_record returns the row already on file rather than
      // a second one, so the same id can come back. Keyed by id here so a
      // re-submission does not read as two results — which is what the dedup
      // index exists to prevent in the first place.
      setSaved((rows) => [record, ...rows.filter((row) => row.id !== record.id)])
      // Cleared so the next event of the same meet for the same swimmer needs
      // only two fields; the member, category and date stay as they were.
      setTime('')
      setStroke('')
      setDistance('')
      setTeammates('')
      // If the staffer filed this against themselves, their own screen is now
      // stale. Cheap to invalidate either way.
      await qc.invalidateQueries({ queryKey: ['my-records'] })
      // A new time can create or move a PB 모먼트 on the same screen.
      await qc.invalidateQueries({ queryKey: ['my-achievement'] })
    },
    onError: () => setState('error'),
  })

  const trimmedStroke = stroke.trim()
  const distanceValue = distance.trim() === '' ? null : Number(distance)
  const distanceValid =
    distanceValue !== null && Number.isInteger(distanceValue) && distanceValue > 0

  // parseSwimTime returns null rather than NaN for anything unreadable, so an
  // unparseable box can never reach upsert_record and come back as a CHECK
  // violation with a Postgres message in it. Zero is refused here for the same
  // reason: result_centiseconds > 0 is a constraint, not a suggestion.
  const centiseconds = parseSwimTime(time)
  const timeValid = centiseconds !== null && centiseconds > 0
  const timeTouched = time.trim() !== ''

  const canSubmit =
    memberId !== '' &&
    trimmedStroke !== '' &&
    distanceValid &&
    eventDate !== '' &&
    timeValid &&
    state !== 'saving'

  function submit() {
    if (!canSubmit || centiseconds === null || distanceValue === null) return
    save.mutate({
      memberId,
      category,
      subcategory,
      stroke: trimmedStroke,
      distanceM: distanceValue,
      eventName: eventName.trim(),
      eventDate,
      // What was typed, kept verbatim beside the number the way a parsed
      // sheet's reading is. The canonical value is the centiseconds.
      resultDisplay: time.trim(),
      resultCentiseconds: centiseconds,
      teammates: subcategory === 'relay' ? parseTeammates(teammates) : [],
    })
  }

  function touched() {
    if (state !== 'saving') setState('idle')
  }

  return (
    <>
      <div style={CARD}>
        <label htmlFor="record-member" style={LABEL}>
          회원
        </label>
        <select
          id="record-member"
          value={memberId}
          onChange={(e) => {
            setMemberId(e.target.value)
            touched()
          }}
          style={FIELD}
        >
          <option value="">회원을 선택하세요</option>
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.short_name ? `${member.nickname} (${member.short_name})` : member.nickname}
            </option>
          ))}
        </select>

        <span style={{ ...LABEL, marginTop: 14 }}>대회 종류</span>
        <div
          role="group"
          aria-label="대회 종류"
          style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}
        >
          {RECORD_CATEGORIES.map((option) => (
            <button
              key={option}
              onClick={() => {
                setCategory(option)
                touched()
              }}
              aria-pressed={category === option}
              style={chip(category === option)}
            >
              {CATEGORY_LABEL[option]}
            </button>
          ))}
        </div>

        <span style={{ ...LABEL, marginTop: 14 }}>종목 구분</span>
        <div
          role="group"
          aria-label="종목 구분"
          style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}
        >
          {RECORD_SUBCATEGORIES.map((option) => (
            <button
              key={option}
              onClick={() => {
                setSubcategory(option)
                touched()
              }}
              aria-pressed={subcategory === option}
              style={chip(subcategory === option)}
            >
              {SUBCATEGORY_LABEL[option]}
            </button>
          ))}
        </div>
      </div>

      <div style={{ ...CARD, marginTop: 14 }}>
        <label htmlFor="record-stroke" style={LABEL}>
          영법
        </label>
        {/* Suggestions, not a closed set — the column is free text because meet
            sheets name events in ways this app does not get to define. */}
        <div
          role="group"
          aria-label="자주 쓰는 영법"
          style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 9 }}
        >
          {STROKE_OPTIONS[subcategory].map((option) => (
            <button
              key={option}
              onClick={() => {
                setStroke(option)
                touched()
              }}
              aria-pressed={trimmedStroke === option}
              style={chip(trimmedStroke === option)}
            >
              {option}
            </button>
          ))}
        </div>
        <input
          id="record-stroke"
          value={stroke}
          onChange={(e) => {
            setStroke(e.target.value)
            touched()
          }}
          placeholder="예: 자유형"
          style={FIELD}
        />

        <label htmlFor="record-distance" style={{ ...LABEL, marginTop: 14 }}>
          거리 (m)
        </label>
        <input
          id="record-distance"
          type="number"
          inputMode="numeric"
          min={1}
          value={distance}
          onChange={(e) => {
            setDistance(e.target.value)
            touched()
          }}
          placeholder="예: 50"
          style={FIELD}
        />
        {distance.trim() !== '' && !distanceValid && (
          <p role="alert" style={{ fontSize: 12, color: '#a33', margin: '8px 0 0' }}>
            거리는 1 이상의 정수여야 합니다.
          </p>
        )}

        <label htmlFor="record-date" style={{ ...LABEL, marginTop: 14 }}>
          날짜
        </label>
        <input
          id="record-date"
          type="date"
          value={eventDate}
          onChange={(e) => {
            setEventDate(e.target.value)
            touched()
          }}
          style={FIELD}
        />

        <label htmlFor="record-event" style={{ ...LABEL, marginTop: 14 }}>
          대회명
        </label>
        <input
          id="record-event"
          value={eventName}
          onChange={(e) => {
            setEventName(e.target.value)
            touched()
          }}
          placeholder="비워 둬도 됩니다"
          style={FIELD}
        />

        <label htmlFor="record-time" style={{ ...LABEL, marginTop: 14 }}>
          기록
        </label>
        <input
          id="record-time"
          value={time}
          onChange={(e) => {
            setTime(e.target.value)
            touched()
          }}
          placeholder="예: 33.08 또는 1:05.32"
          inputMode="decimal"
          aria-describedby="record-time-help"
          style={FIELD}
        />
        {/* Read back from the parsed number rather than echoed from the box:
            seeing '1:00.00' after typing '60.00' is how someone catches a slip
            before it is on file. */}
        <p id="record-time-help" style={{ fontSize: 12, margin: '6px 0 0', color: '#6b7178' }}>
          {timeTouched && timeValid
            ? `저장될 기록 · ${formatCentiseconds(centiseconds)}`
            : '초 단위로 적습니다. 1분이 넘으면 분:초.1/100초 형식입니다.'}
        </p>
        {timeTouched && !timeValid && (
          <p role="alert" style={{ fontSize: 12, color: '#a33', margin: '8px 0 0' }}>
            기록을 읽을 수 없습니다. 33.08 또는 1:05.32 형식으로 적어 주세요.
          </p>
        )}

        {subcategory === 'relay' && (
          <>
            <label htmlFor="record-teammates" style={{ ...LABEL, marginTop: 14 }}>
              함께한 선수
            </label>
            <input
              id="record-teammates"
              value={teammates}
              onChange={(e) => {
                setTeammates(e.target.value)
                touched()
              }}
              placeholder="쉼표로 구분합니다. 예: 김철수, 이영희"
              style={FIELD}
            />
          </>
        )}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 9,
          marginTop: 14,
        }}
      >
        <SaveState state={state} onRetry={canSubmit ? submit : undefined} />
        <button
          onClick={submit}
          disabled={!canSubmit}
          style={{
            minHeight: 44,
            minWidth: 96,
            padding: '0 18px',
            borderRadius: 13,
            border: 'none',
            background: canSubmit ? '#111317' : '#e1e5ea',
            color: canSubmit ? '#fff' : '#6b7178',
            fontSize: 13,
          }}
        >
          등록
        </button>
      </div>

      {saved.length > 0 && (
        <section style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 13, color: '#6b7178', fontWeight: 400, margin: '0 0 9px' }}>
            방금 등록한 기록
          </h2>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 9 }}>
            {saved.map((record) => (
              <li
                key={record.id}
                style={{ ...CARD, display: 'flex', justifyContent: 'space-between', gap: 9 }}
              >
                <span style={{ fontSize: 13 }}>
                  {record.event_date.replaceAll('-', '.')} {record.stroke} {record.distance_m}m
                </span>
                <strong style={{ fontSize: 13 }}>
                  {formatCentiseconds(record.result_centiseconds) ?? record.result_display}
                </strong>
              </li>
            ))}
          </ul>
          <p style={{ fontSize: 11, color: '#6b7178', margin: '9px 0 0' }}>
            같은 사람의 같은 종목·날짜·거리·기록은 한 번만 저장됩니다. 이미 있는 기록을 다시
            등록하면 서버가 기존 기록을 그대로 돌려줍니다.
          </p>
        </section>
      )}
    </>
  )
}
