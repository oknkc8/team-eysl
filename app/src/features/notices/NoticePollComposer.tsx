import { useState } from 'react'
import {
  deadlineToIso,
  isoToDeadlineInput,
  type Poll,
  type PollDraft,
  type PollDraftOption,
  type PollOptionKind,
} from './pollApi'

const CARD = {
  padding: 14,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
  marginTop: 14,
} as const

const FIELD = {
  width: '100%',
  boxSizing: 'border-box',
  padding: 12,
  borderRadius: 13,
  border: '1px solid #e1e5ea',
  fontSize: 14,
  fontFamily: 'inherit',
} as const

const LABEL = { display: 'block', fontSize: 12, color: '#6b7178', marginBottom: 6 } as const
const MUTED = { fontSize: 11, color: '#6b7178' } as const

const removeStyle = {
  minHeight: 36,
  padding: '0 12px',
  borderRadius: 11,
  border: '1px solid #e1e5ea',
  background: '#fff',
  color: '#6b7178',
  fontSize: 12,
} as const

// Matches save_notice_poll_v1's cap. Restated rather than shared for the reason
// MAX_ATTACHMENTS is: the server's number is the real one, and this only decides
// when to stop offering 항목 추가.
const MAX_OPTIONS = 30
const MIN_OPTIONS = 2

/**
 * A row in the composer. `id` is present only for an option ALREADY ON THE POLL.
 *
 * That distinction is load-bearing and is why this type is not PollDraftOption:
 * `key` needs a value for a brand-new row too, and using the label would make
 * two blank rows share a key and collapse into one. `key` is local and never
 * sent; `id` is sent and decides whether the server keeps the option's votes or
 * creates a fresh one.
 */
type Row = { key: string; id?: string; label: string }

let rowSeq = 0
function blankRow(): Row {
  rowSeq += 1
  return { key: `new-${rowSeq}`, label: '' }
}

/** The composer's whole state, so the parent can hold one value. */
export type PollComposerState = {
  enabled: boolean
  title: string
  option_kind: PollOptionKind
  rows: Row[]
  allow_multiple: boolean
  anonymous: boolean
  allow_option_add: boolean
  /** The `datetime-local` box's raw value, converted only on submit. */
  closes_at_local: string
}

export function emptyPollComposerState(): PollComposerState {
  return {
    enabled: false,
    title: '',
    option_kind: 'text',
    rows: [blankRow(), blankRow()],
    allow_multiple: false,
    anonymous: false,
    allow_option_add: false,
    closes_at_local: '',
  }
}

/** Seed the composer from a poll the notice already has. */
export function pollComposerStateFrom(poll: Poll | null): PollComposerState {
  if (!poll) return emptyPollComposerState()
  const rows: Row[] = poll.options.map((option) => ({
    key: option.id,
    id: option.id,
    label: option.label,
  }))
  while (rows.length < MIN_OPTIONS) rows.push(blankRow())
  return {
    enabled: true,
    title: poll.title,
    option_kind: poll.option_kind,
    rows,
    allow_multiple: poll.allow_multiple,
    anonymous: poll.anonymous,
    allow_option_add: poll.allow_option_add,
    closes_at_local: isoToDeadlineInput(poll.closes_at),
  }
}

/**
 * What to send for this composer state: a draft to save, or null to delete.
 *
 * PURE, AND SEPARATE FROM THE COMPONENT, the same reason nextEditorStateAfterSave
 * is: the decision "this poll should be deleted" is one a screen can get wrong
 * silently, and a decision nothing can call without rendering a page is a
 * decision nothing can test.
 *
 * Throws rather than returning a partial draft, because a poll with one option
 * or no title is not a smaller poll — it is a save that must not happen. The
 * server refuses both as well; this is what puts a Korean sentence in front of
 * the person instead of a PostgREST error.
 */
export function pollDraftFrom(state: PollComposerState): PollDraft | null {
  if (!state.enabled) return null

  const title = state.title.trim()
  if (!title) throw new Error('투표 제목을 입력해주세요')

  const options: PollDraftOption[] = state.rows
    .map((row) => ({ id: row.id, label: row.label.trim() }))
    .filter((row) => row.label.length > 0)
  if (options.length < MIN_OPTIONS) throw new Error('투표 항목을 2개 이상 입력해주세요')

  if (state.option_kind === 'date') {
    const bad = options.find((option) => !/^\d{4}-\d{2}-\d{2}$/.test(option.label))
    if (bad) throw new Error('날짜 항목은 YYYY-MM-DD 형식이어야 합니다')
  }

  // Two rows carrying the same text are one option to everybody reading the
  // screen, and add_notice_poll_option_v1 refuses the same thing on its own
  // path. Refused here too so the composer does not save a poll the member
  // cannot then add to.
  const seen = new Set<string>()
  for (const option of options) {
    const key = option.label.toLowerCase()
    if (seen.has(key)) throw new Error('같은 항목이 두 번 들어 있습니다')
    seen.add(key)
  }

  return {
    title,
    option_kind: state.option_kind,
    options,
    allow_multiple: state.allow_multiple,
    anonymous: state.anonymous,
    allow_option_add: state.allow_option_add,
    // Throws its own sentence on an unparseable box.
    closes_at: deadlineToIso(state.closes_at_local),
  }
}

/**
 * 투표 추가/수정, inside the notice form.
 *
 * Controlled: the parent owns the state so that it can build the draft at the
 * moment it saves the notice. A poll cannot be attached to a notice that does
 * not exist yet, so on a NEW notice the parent saves the notice first and the
 * poll second — which means a poll save can fail after the notice succeeded,
 * and the parent has to say so rather than navigate away.
 */
export function NoticePollComposer({
  state,
  onChange,
  disabled,
}: {
  state: PollComposerState
  onChange: (next: PollComposerState) => void
  disabled?: boolean
}) {
  const [error, setError] = useState<string | null>(null)
  const patch = (over: Partial<PollComposerState>) => onChange({ ...state, ...over })

  if (!state.enabled) {
    return (
      <button
        onClick={() => onChange({ ...emptyPollComposerState(), enabled: true })}
        disabled={disabled}
        style={{
          ...CARD,
          width: '100%',
          fontSize: 14,
          color: '#6b7178',
          fontFamily: 'inherit',
        }}
      >
        ＋ 투표 추가하기
      </button>
    )
  }

  function removeRow(key: string) {
    if (state.rows.length <= MIN_OPTIONS) {
      setError('투표 항목은 최소 2개가 필요합니다.')
      return
    }
    setError(null)
    patch({ rows: state.rows.filter((row) => row.key !== key) })
  }

  return (
    <div style={CARD}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 7 }}>
          {(['text', 'date'] as const).map((kind) => (
            <button
              key={kind}
              onClick={() => patch({ option_kind: kind })}
              disabled={disabled}
              style={{
                minHeight: 36,
                padding: '0 14px',
                borderRadius: 999,
                border: `1px solid ${state.option_kind === kind ? '#111317' : '#e1e5ea'}`,
                background: state.option_kind === kind ? '#111317' : '#fff',
                color: state.option_kind === kind ? '#fff' : '#6b7178',
                fontSize: 12,
              }}
            >
              {kind === 'text' ? '텍스트' : '날짜'}
            </button>
          ))}
        </div>
        <button
          onClick={() => onChange(emptyPollComposerState())}
          disabled={disabled}
          style={{ ...removeStyle, border: 'none', background: 'none' }}
        >
          투표 삭제
        </button>
      </div>

      <label htmlFor="poll-title" style={LABEL}>
        투표 제목
      </label>
      <input
        id="poll-title"
        value={state.title}
        onChange={(e) => patch({ title: e.target.value })}
        disabled={disabled}
        placeholder="투표 제목"
        style={{ ...FIELD, minHeight: 44 }}
      />

      <span style={{ ...LABEL, marginTop: 14 }}>투표 항목</span>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 7 }}>
        {state.rows.map((row) => (
          <li key={row.key} style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
            <input
              // A date poll gets a date picker, which is what makes the server's
              // YYYY-MM-DD check something the member never meets.
              type={state.option_kind === 'date' ? 'date' : 'text'}
              value={row.label}
              onChange={(e) =>
                patch({
                  rows: state.rows.map((other) =>
                    other.key === row.key ? { ...other, label: e.target.value } : other,
                  ),
                })
              }
              disabled={disabled}
              placeholder="항목 입력"
              aria-label="투표 항목"
              style={{ ...FIELD, minHeight: 44 }}
            />
            <button onClick={() => removeRow(row.key)} disabled={disabled} style={removeStyle}>
              제거
            </button>
          </li>
        ))}
      </ul>

      <button
        onClick={() => patch({ rows: [...state.rows, blankRow()] })}
        disabled={disabled || state.rows.length >= MAX_OPTIONS}
        style={{
          ...FIELD,
          minHeight: 42,
          marginTop: 8,
          background: '#f6f8fa',
          color: '#6b7178',
          fontSize: 12,
        }}
      >
        ＋ 항목 추가
      </button>

      <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
        <Check
          id="poll-multiple"
          label="복수선택"
          checked={state.allow_multiple}
          disabled={disabled}
          onChange={(next) => patch({ allow_multiple: next })}
        />
        <Check
          id="poll-anonymous"
          label="익명투표 (이름을 공개하지 않음)"
          checked={state.anonymous}
          disabled={disabled}
          onChange={(next) => patch({ anonymous: next })}
        />
        <Check
          id="poll-allow-add"
          label="회원이 선택항목을 추가할 수 있음"
          checked={state.allow_option_add}
          disabled={disabled}
          onChange={(next) => patch({ allow_option_add: next })}
        />
      </div>

      {/* Says what 익명 actually buys, because 0055's header records that it is
          less than the word suggests: with few voters the counts alone can name
          somebody. Promising secrecy here would be a sentence this app makes
          false the moment a poll has one voter. */}
      {state.anonymous && (
        <p style={{ ...MUTED, margin: '10px 0 0', lineHeight: 1.6 }}>
          누가 무엇을 골랐는지는 운영진에게도 보이지 않습니다. 다만 참여자가 적으면 표 수만으로
          짐작될 수 있습니다.
        </p>
      )}

      <label htmlFor="poll-closes" style={{ ...LABEL, marginTop: 14 }}>
        투표 종료시간
      </label>
      <input
        id="poll-closes"
        type="datetime-local"
        value={state.closes_at_local}
        onChange={(e) => patch({ closes_at_local: e.target.value })}
        disabled={disabled}
        style={{ ...FIELD, minHeight: 44 }}
      />
      <p style={{ ...MUTED, margin: '8px 0 0' }}>
        비워두면 종료시간 없이 계속 열려 있습니다. 종료 이후에는 서버가 투표를 받지 않습니다.
      </p>

      {error && (
        <p role="alert" className="authMsg error" style={{ marginTop: 10 }}>
          {error}
        </p>
      )}
    </div>
  )
}

function Check({
  id,
  label,
  checked,
  disabled,
  onChange,
}: {
  id: string
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <label htmlFor={id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 20, height: 20, margin: 0 }}
      />
      {label}
    </label>
  )
}
