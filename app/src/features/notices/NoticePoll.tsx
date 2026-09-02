import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { SaveState } from '../../components/ui/SaveState'
import {
  addPollOption,
  canVote,
  castVote,
  formatDeadline,
  formatOptionLabel,
  getPoll,
  nextSelection,
  votersFor,
  type Poll,
  type PollOption,
} from './pollApi'

// Poll-specific styling is inline, the way NoticeEditPage's is: components.css
// is outside this branch's scope, and a feature that has to edit the shared
// stylesheet to render is a feature three other in-flight branches collide with.
const CARD = {
  padding: 16,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
  marginTop: 18,
} as const

const MUTED = { fontSize: 11, color: '#6b7178' } as const

const optionRow = (selected: boolean, disabled: boolean) =>
  ({
    width: '100%',
    display: 'grid',
    gridTemplateColumns: '22px minmax(0, 1fr) auto',
    gap: 10,
    alignItems: 'center',
    textAlign: 'left',
    padding: '11px 12px',
    borderRadius: 13,
    border: `1px solid ${selected ? '#111317' : '#e1e5ea'}`,
    background: selected ? '#f3f4f6' : '#fafbfc',
    // Not `cursor: not-allowed`: a closed poll is a normal state, not a refusal.
    cursor: disabled ? 'default' : 'pointer',
    font: 'inherit',
  }) as const

const mark = (selected: boolean) =>
  ({
    width: 20,
    height: 20,
    borderRadius: '50%',
    border: `2px solid ${selected ? '#111317' : '#aab1b8'}`,
    background: selected ? '#111317' : 'transparent',
    boxShadow: selected ? 'inset 0 0 0 4px #fff' : 'none',
  }) as const

/**
 * 공지 투표 as the detail screen shows it.
 *
 * Renders nothing at all when the notice has no poll — most notices do not, and
 * an "투표 없음" card on every one of them would be noise. That is also why the
 * pending state is silent: a shimmer that resolves to nothing on nine notices
 * out of ten is a flash of furniture, so the card appears only once there is
 * something to put in it.
 */
export function NoticePoll({ noticeId }: { noticeId: string }) {
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: ['notice-poll', noticeId],
    queryFn: () => getPoll(noticeId),
    enabled: !!noticeId,
  })

  // Nothing to draw, and no frame around the nothing. AsyncSection is not used
  // here for exactly that reason: its three branches all render something, and
  // all three would be wrong on a notice that simply has no poll — which is
  // most of them. A failed fetch is silent for the same reason a missing poll
  // is: there is no way to tell the two apart on screen without claiming one.
  if (query.isPending || query.isError || !query.data) return null

  return (
    <PollCard
      poll={query.data}
      onChanged={(next) => {
        // The server's answer becomes the cache, so the counts on screen are the
        // ones it just computed rather than a local increment — the same reason
        // appendComment refetches instead of appending its own row.
        qc.setQueryData(['notice-poll', noticeId], next)
      }}
    />
  )
}

function PollCard({ poll, onChanged }: { poll: Poll; onChanged: (next: Poll) => void }) {
  const [selection, setSelection] = useState<string[]>(poll.my_option_ids)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [message, setMessage] = useState<string | null>(null)

  // The server's ballot wins whenever it changes underneath — after a cast, or
  // after somebody else's option arrives. Keyed on the joined ids rather than on
  // the array, which is a new object on every render.
  // The dependency is the JOINED string, not the array: my_option_ids is a new
  // array object on every render, so depending on it directly would re-run this
  // effect forever and stamp the server's ballot over a selection the member is
  // still making.
  const serverSelection = poll.my_option_ids.join(',')
  useEffect(() => {
    setSelection(serverSelection ? serverSelection.split(',') : [])
  }, [serverSelection])

  // A DECISION MADE ONCE, BY canVote, and read everywhere below. The database
  // makes the same decision under a row lock and refuses a late vote whatever
  // this says; this only decides what is drawn.
  const open = canVote(poll)

  const cast = useMutation({
    mutationFn: (optionIds: string[]) => castVote(poll.id, optionIds),
    onMutate: () => {
      setMessage(null)
      setSaveState('saving')
    },
    onSuccess: (next) => {
      if (next) onChanged(next)
      setSaveState('saved')
    },
    onError: (error) => {
      // The one refusal worth naming: the deadline moved, or this screen was
      // open past it. Everything else stays generic rather than guessing.
      const code = (error as { code?: string } | null)?.code
      setMessage(
        code === '42501'
          ? '마감된 투표입니다. 화면을 새로고침해 주세요.'
          : '투표를 저장하지 못했습니다.',
      )
      setSaveState('error')
    },
  })

  const savedSelection = poll.my_option_ids
  const changed =
    selection.length !== savedSelection.length ||
    selection.some((id) => !savedSelection.includes(id))

  return (
    <section style={CARD} aria-label="공지 투표">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 17, letterSpacing: -0.4, wordBreak: 'break-word' }}>
            {poll.title}
          </h2>
          <p style={{ ...MUTED, margin: '6px 0 0' }}>
            {poll.allow_multiple && '복수선택 · '}
            {/* Says what anonymity actually is. It is not "your vote is secret":
                0055's header records that a one-voter poll leaks by arithmetic,
                and a sentence here promising secrecy would be false the way this
                project keeps finding sentences to be. */}
            {poll.anonymous && '익명(이름 비공개) · '}
            {poll.total_voters}명 참여 · {formatDeadline(poll.closes_at)}
          </p>
        </div>
        {!open && (
          <span
            style={{
              ...MUTED,
              alignSelf: 'flex-start',
              whiteSpace: 'nowrap',
              padding: '5px 9px',
              borderRadius: 999,
              background: '#eceff2',
            }}
          >
            투표 종료
          </span>
        )}
      </div>

      <div style={{ display: 'grid', gap: 8, marginTop: 14 }}>
        {poll.options.map((option) => (
          <OptionRow
            key={option.id}
            poll={poll}
            option={option}
            selected={selection.includes(option.id)}
            // THE CLOSED POLL DOES NOT OFFER THE CONTROL. `disabled` on the
            // button rather than a hidden one, so the result stays readable.
            disabled={!open || saveState === 'saving'}
            onToggle={() =>
              setSelection((current) => nextSelection(current, option.id, poll.allow_multiple))
            }
          />
        ))}
      </div>

      {open && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 9,
            marginTop: 13,
          }}
        >
          <SaveState
            state={saveState}
            onRetry={changed ? () => cast.mutate(selection) : undefined}
          />
          {savedSelection.length > 0 && (
            <button
              onClick={() => cast.mutate([])}
              disabled={saveState === 'saving'}
              className="btn outline"
              style={{ minHeight: 42 }}
            >
              투표 취소
            </button>
          )}
          <button
            onClick={() => cast.mutate(selection)}
            // Nothing to send is not a vote. An empty ballot is 투표 취소 and has
            // its own button, so this one refuses rather than quietly retracting.
            disabled={selection.length === 0 || !changed || saveState === 'saving'}
            className="btn primary"
            style={{ minHeight: 42 }}
          >
            {savedSelection.length > 0 ? '투표 수정' : '투표하기'}
          </button>
        </div>
      )}

      {poll.can_add_option && <AddOption poll={poll} onChanged={onChanged} />}

      {message && (
        <p role="alert" className="authMsg error" style={{ marginTop: 10 }}>
          {message}
        </p>
      )}
    </section>
  )
}

function OptionRow({
  poll,
  option,
  selected,
  disabled,
  onToggle,
}: {
  poll: Poll
  option: PollOption
  selected: boolean
  disabled: boolean
  onToggle: () => void
}) {
  // THE ANONYMITY RULE ON SCREEN, and it is one call rather than a condition
  // written out here. votersFor returns null for an anonymous poll — to
  // everybody, staff and the poll's author included — so there is no branch in
  // this component that could be got wrong later by adding a role check.
  const voters = votersFor(poll, option)

  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={selected}
      style={optionRow(selected, disabled)}
    >
      <span style={mark(selected)} aria-hidden="true" />
      <span style={{ minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 700, overflowWrap: 'anywhere' }}>
          {formatOptionLabel(option.label, poll.option_kind)}
        </span>
        {/* Rendered only when there are names to render. An empty list means
            nobody chose this option, and a blank line under it is not
            information — the count already says zero. */}
        {voters && (
          <span style={{ ...MUTED, display: 'block', marginTop: 4, lineHeight: 1.5 }}>
            {voters.join(' · ')}
          </span>
        )}
      </span>
      <span style={MUTED}>{option.count}명</span>
    </button>
  )
}

/** 선택항목 추가. Shown only where the server said the caller may add one. */
function AddOption({ poll, onChanged }: { poll: Poll; onChanged: (next: Poll) => void }) {
  const [label, setLabel] = useState('')
  const [error, setError] = useState<string | null>(null)

  const add = useMutation({
    mutationFn: () => addPollOption(poll.id, label.trim()),
    onMutate: () => setError(null),
    onSuccess: (next) => {
      if (next) onChanged(next)
      setLabel('')
    },
    // The server's own sentence where it wrote one — 이미 있는 항목입니다,
    // 날짜 항목은 YYYY-MM-DD 형식이어야 합니다 — because it is more specific than
    // anything this component could guess, and it is already Korean.
    onError: (err) =>
      setError((err as { message?: string } | null)?.message ?? '항목을 추가하지 못했습니다.'),
  })

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', gap: 7 }}>
        <label htmlFor={`poll-add-${poll.id}`} className="sr-only">
          선택항목 추가
        </label>
        <input
          id={`poll-add-${poll.id}`}
          type={poll.option_kind === 'date' ? 'date' : 'text'}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="선택항목 추가"
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 42,
            padding: '0 12px',
            borderRadius: 12,
            border: '1px solid #e1e5ea',
            fontSize: 13,
            fontFamily: 'inherit',
          }}
        />
        <button
          onClick={() => add.mutate()}
          disabled={label.trim().length === 0 || add.isPending}
          className="btn"
          style={{ minHeight: 42 }}
        >
          추가
        </button>
      </div>
      {error && (
        <p role="alert" className="authMsg error" style={{ marginTop: 8 }}>
          {error}
        </p>
      )}
    </div>
  )
}
