import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { SaveState } from '../../components/ui/SaveState'
import {
  getMemberLinkBoard,
  linkMemberLogin,
  setSignupPass,
  type MemberLinkBoard,
  type MemberLinkSignup,
  type MemberLinkSummary,
} from './api'

const CARD = {
  padding: 14,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
} as const

const MUTED = { fontSize: 11, color: '#6b7178' } as const

/**
 * A pass is stored as an expiry, and the column is NOT cleared when it lapses —
 * 0037 asks `signup_pass_expires_at > now()` rather than `is not null`, so a
 * stale timestamp sits in the row indefinitely. The screen has to ask the same
 * question the guard asks, or a roster row would read 허용됨 forever after one
 * pass was issued months ago.
 */
function livePassUntil(iso: string | null): Date | null {
  if (!iso) return null
  const at = new Date(iso)
  const t = at.getTime()
  if (!Number.isFinite(t) || t <= Date.now()) return null
  return at
}

const formatDay = (value: Date | string) =>
  new Date(value).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' })

/** 출석 9회 · 기록 20건 · 신청 3건 — what a 연결 would carry over. */
function weightOf(member: MemberLinkSummary): string {
  return [
    `출석 ${member.attendance_count}회`,
    `기록 ${member.record_count}건`,
    `신청 ${member.application_count}건`,
  ].join(' · ')
}

/** 98년생 · 남 · 가입 2015-03 — the fields the signup guard actually compared. */
function identityOf(member: MemberLinkSummary): string {
  const parts: string[] = []
  if (member.birth_year !== null) parts.push(`${member.birth_year % 100}년생`)
  if (member.gender) parts.push(member.gender)
  if (member.join_date_text) parts.push(`가입 ${member.join_date_text}`)
  return parts.join(' · ')
}

type Pending =
  | { kind: 'link'; signupMemberId: string; targetMemberId: string }
  | { kind: 'pass'; memberId: string; allowed: boolean }

export function MemberLinkPage() {
  const qc = useQueryClient()
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  // Kept so 다시 시도 resends the decision that failed rather than whichever one
  // was clicked most recently — the same reason MemberAccessPage keeps one.
  const [pending, setPending] = useState<Pending | null>(null)
  // Which signup, if any, has the roster picker open beneath it. Only one at a
  // time: two open pickers on a phone is two identical search boxes and no way
  // to tell which signup a 연결 button belongs to.
  const [pickerFor, setPickerFor] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<string | null>(null)

  const query = useQuery({ queryKey: ['member-link-board'], queryFn: getMemberLinkBoard })

  async function refresh() {
    await qc.invalidateQueries({ queryKey: ['member-link-board'] })
    // A link approves the target row, which puts them into member_public_v and
    // therefore into every roster-shaped screen.
    await qc.invalidateQueries({ queryKey: ['roster'] })
    await qc.invalidateQueries({ queryKey: ['member-options'] })
    await qc.invalidateQueries({ queryKey: ['approval-queue'] })
    await qc.invalidateQueries({ queryKey: ['member-access'] })
  }

  const run = useMutation({
    mutationFn: async (input: Pending) => {
      if (input.kind === 'pass') {
        await setSignupPass({ memberId: input.memberId, allowed: input.allowed })
        return null
      }
      const result = await linkMemberLogin({
        signupMemberId: input.signupMemberId,
        targetMemberId: input.targetMemberId,
      })
      return result.member
    },
    onMutate: (input) => {
      setPending(input)
      setReceipt(null)
      setState('saving')
    },
    onSuccess: async (member) => {
      setState('saved')
      setPickerFor(null)
      // The receipt names what actually moved. An admin who picked the wrong row
      // sees it here rather than trusting a green tick — which is why
      // link_member_login_v1 returns the counts at all.
      if (member) {
        setReceipt(`${member.nickname} 님에게 ${weightOf(member)}을 연결했습니다.`)
      }
      await refresh()
    },
    onError: () => setState('error'),
  })

  const busy = state === 'saving'

  function confirmLink(signup: MemberLinkSignup, target: MemberLinkSummary, matched: boolean) {
    // window.confirm rather than a bare button, and the text carries BOTH sides
    // plus the weight. This call moves an auth account and deletes a row; there
    // is no undo inside the app, so the last thing between a mis-tap and handing
    // somebody a stranger's history is this sentence.
    const lines = [
      `"${signup.nickname}" 계정을`,
      `"${target.nickname}" 님의 기존 회원 정보로 옮깁니다.`,
      '',
      `기존 회원 정보: ${weightOf(target)}`,
      `가입 신청 계정은 삭제되고, 앞으로 "${signup.nickname}"으로 로그인하면`,
      '위 기록이 그대로 보이게 됩니다.',
      '',
    ]
    if (!matched) {
      // The override. The guard did not match these two, so the only thing
      // joining them is the admin's belief about who this person is.
      lines.push(
        '주의: 이 회원은 가입 정보(이름·출생년도·성별)가 신청과 일치하지 않습니다.',
        '직접 확인하고 연결하는 것입니다.',
        '',
      )
    }
    lines.push('이 작업은 되돌릴 수 없습니다. 진행할까요?')

    if (!window.confirm(lines.join('\n'))) return
    run.mutate({ kind: 'link', signupMemberId: signup.id, targetMemberId: target.id })
  }

  function togglePass(member: MemberLinkSummary) {
    const until = livePassUntil(member.signup_pass_expires_at)
    if (until) {
      if (!window.confirm(`${member.nickname} 님의 가입 허용을 취소할까요?`)) return
      run.mutate({ kind: 'pass', memberId: member.id, allowed: false })
      return
    }
    const ok = window.confirm(
      `${member.nickname} 님이 가입 신청을 할 수 있도록 허용할까요?\n\n` +
        '이 회원 정보와 일치하는 가입 신청 한 건이 통과됩니다.\n' +
        '계정이 바로 연결되지는 않고, 신청이 들어오면 이 화면에서 연결해야 합니다.',
    )
    if (!ok) return
    run.mutate({ kind: 'pass', memberId: member.id, allowed: true })
  }

  return (
    <div className="page">
      <Link to="/members" className="backLink">
        ← 회원
      </Link>

      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 9,
          margin: '12px 0 6px',
        }}
      >
        <h1 style={{ fontSize: 22, letterSpacing: -0.8, margin: 0 }}>회원 연결</h1>
        <SaveState state={state} onRetry={pending ? () => run.mutate(pending) : undefined} />
      </header>

      <p style={{ ...MUTED, margin: '0 0 16px', lineHeight: 1.6 }}>
        예전부터 활동했지만 앱 계정이 없는 회원은 가입할 때 자동으로 막힙니다. 여기서 가입을 허용해
        주고, 신청이 들어오면 기존 회원 정보에 연결해 주세요. 연결하면 그동안의 출석과 기록을 그대로
        쓰게 됩니다.
      </p>

      {receipt && (
        <p
          style={{
            ...CARD,
            margin: '0 0 16px',
            background: '#edf7f2',
            borderColor: '#edf7f2',
            color: '#11805b',
            fontSize: 13,
          }}
        >
          {receipt}
        </p>
      )}

      <AsyncSection
        query={query}
        isEmpty={(board) => board.signups.length === 0 && board.roster.length === 0}
        loading={<Shimmer rows={4} />}
        empty="연결할 회원이 없습니다"
        error="회원 연결 정보를 불러오지 못했습니다"
      >
        {(board) => (
          <Board
            board={board}
            busy={busy}
            pickerFor={pickerFor}
            onPicker={setPickerFor}
            onLink={confirmLink}
            onPass={togglePass}
          />
        )}
      </AsyncSection>
    </div>
  )
}

function Board({
  board,
  busy,
  pickerFor,
  onPicker,
  onLink,
  onPass,
}: {
  board: MemberLinkBoard
  busy: boolean
  pickerFor: string | null
  onPicker: (id: string | null) => void
  onLink: (signup: MemberLinkSignup, target: MemberLinkSummary, matched: boolean) => void
  onPass: (member: MemberLinkSummary) => void
}) {
  return (
    <>
      <section style={{ marginBottom: 26 }}>
        <h2 style={{ ...MUTED, fontWeight: 400, margin: '0 0 9px' }}>
          연결 대기 {board.signups.length}건
        </h2>
        {board.signups.length === 0 ? (
          <p style={{ ...CARD, ...MUTED, fontSize: 13, margin: 0 }}>
            연결을 기다리는 가입 신청이 없습니다.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 9 }}>
            {board.signups.map((signup) => (
              <li key={signup.id} style={CARD}>
                <SignupCard
                  signup={signup}
                  roster={board.roster}
                  busy={busy}
                  pickerOpen={pickerFor === signup.id}
                  onPicker={onPicker}
                  onLink={onLink}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <PassSection roster={board.roster} busy={busy} onPass={onPass} />
    </>
  )
}

function SignupCard({
  signup,
  roster,
  busy,
  pickerOpen,
  onPicker,
  onLink,
}: {
  signup: MemberLinkSignup
  roster: MemberLinkSummary[]
  busy: boolean
  pickerOpen: boolean
  onPicker: (id: string | null) => void
  onLink: (signup: MemberLinkSignup, target: MemberLinkSummary, matched: boolean) => void
}) {
  const matchedIds = useMemo(() => new Set(signup.candidates.map((c) => c.id)), [signup.candidates])

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 15 }}>{signup.nickname}</b>
        {signup.created_at && <span style={MUTED}>{formatDay(signup.created_at)} 신청</span>}
      </div>

      {signup.candidates.length === 0 ? (
        <p style={{ ...MUTED, margin: '10px 0 0', lineHeight: 1.6 }}>
          이름·출생년도·성별이 일치하는 기존 회원이 없습니다. 새로 가입한 회원이라면 가입 승인
          화면에서 승인해 주세요.
        </p>
      ) : (
        <>
          <p style={{ ...MUTED, margin: '10px 0 7px' }}>
            {/* Plural matters: two roster rows can share a name, birth year and
                gender, and the admin is the one who knows which. */}
            일치하는 기존 회원 {signup.candidates.length}명 — 연결할 회원을 선택하세요
          </p>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 7 }}>
            {signup.candidates.map((candidate) => (
              <li key={candidate.id}>
                <CandidateRow
                  member={candidate}
                  busy={busy}
                  onLink={() => onLink(signup, candidate, true)}
                />
              </li>
            ))}
          </ul>
        </>
      )}

      <button
        onClick={() => onPicker(pickerOpen ? null : signup.id)}
        disabled={busy}
        style={{
          marginTop: 10,
          minHeight: 40,
          padding: '0 14px',
          borderRadius: 12,
          border: '1px solid #e1e5ea',
          background: '#fff',
          color: '#3c4148',
          fontSize: 12,
        }}
      >
        {pickerOpen ? '직접 찾기 닫기' : '목록에서 직접 찾기'}
      </button>

      {pickerOpen && (
        <RosterPicker
          roster={roster}
          matchedIds={matchedIds}
          busy={busy}
          onPick={(member) => onLink(signup, member, matchedIds.has(member.id))}
        />
      )}
    </>
  )
}

function CandidateRow({
  member,
  busy,
  onLink,
}: {
  member: MemberLinkSummary
  busy: boolean
  onLink: () => void
}) {
  const identity = identityOf(member)
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: 10,
        borderRadius: 13,
        background: '#f6f8fa',
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        <b style={{ display: 'block', fontSize: 13 }}>
          {member.nickname}
          {member.real_name && (
            <span style={{ ...MUTED, fontWeight: 400 }}> · {member.real_name}</span>
          )}
        </b>
        {identity && <span style={{ ...MUTED, display: 'block' }}>{identity}</span>}
        {/* The weight of the row, on the same line as the button that moves it. */}
        <span style={{ ...MUTED, display: 'block' }}>{weightOf(member)}</span>
      </span>
      <Link to={`/members/${member.id}`} style={{ ...MUTED, textDecoration: 'underline' }}>
        상세
      </Link>
      <button
        onClick={onLink}
        disabled={busy}
        style={{
          minHeight: 40,
          padding: '0 14px',
          borderRadius: 12,
          border: 'none',
          background: busy ? '#e1e5ea' : '#11805b',
          color: busy ? '#6b7178' : '#fff',
          fontSize: 13,
        }}
      >
        연결
      </button>
    </div>
  )
}

/** Search over every loginless row, for the match the guard could not make. */
function RosterPicker({
  roster,
  matchedIds,
  busy,
  onPick,
}: {
  roster: MemberLinkSummary[]
  matchedIds: Set<string>
  busy: boolean
  onPick: (member: MemberLinkSummary) => void
}) {
  const [term, setTerm] = useState('')
  const found = useMemo(() => filterMembers(roster, term), [roster, term])

  return (
    <div style={{ marginTop: 10 }}>
      <p style={{ ...MUTED, margin: '0 0 7px', lineHeight: 1.6 }}>
        명부의 이름이 다르거나 출생년도가 잘못 적혀 있으면 자동으로 찾지 못합니다. 누구인지 아는
        경우에만 직접 선택하세요.
      </p>
      <label htmlFor="link-search" className="sr-only">
        기존 회원 검색
      </label>
      <input
        id="link-search"
        className="field"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="이름으로 찾기"
        type="search"
        autoComplete="off"
      />
      {found.length === 0 ? (
        <p style={{ ...MUTED, margin: '9px 0 0' }}>찾는 회원이 없습니다.</p>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: '9px 0 0',
            display: 'grid',
            gap: 7,
            maxHeight: 320,
            overflowY: 'auto',
          }}
        >
          {found.map((member) => (
            <li key={member.id}>
              <CandidateRow member={member} busy={busy} onLink={() => onPick(member)} />
              {!matchedIds.has(member.id) && (
                <span style={{ ...MUTED, display: 'block', margin: '3px 0 0 10px' }}>
                  가입 정보가 신청과 일치하지 않습니다
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function PassSection({
  roster,
  busy,
  onPass,
}: {
  roster: MemberLinkSummary[]
  busy: boolean
  onPass: (member: MemberLinkSummary) => void
}) {
  const [term, setTerm] = useState('')
  const found = useMemo(() => filterMembers(roster, term), [roster, term])

  return (
    <section>
      <h2 style={{ ...MUTED, fontWeight: 400, margin: '0 0 4px' }}>
        로그인이 없는 회원 {roster.length}명
      </h2>
      <p style={{ ...MUTED, margin: '0 0 9px', lineHeight: 1.6 }}>
        가입하려다 막힌 회원이 연락해 오면 가입을 허용해 주세요. 허용해도 계정이 바로 연결되지는
        않습니다.
      </p>

      <label htmlFor="pass-search" className="sr-only">
        회원 검색
      </label>
      <input
        id="pass-search"
        className="field"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="이름으로 찾기"
        type="search"
        autoComplete="off"
      />

      {found.length === 0 ? (
        <p style={{ ...CARD, ...MUTED, fontSize: 13, margin: '9px 0 0' }}>
          {roster.length === 0 ? '로그인이 없는 회원이 없습니다.' : '찾는 회원이 없습니다.'}
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '9px 0 0', display: 'grid', gap: 9 }}>
          {found.map((member) => {
            const until = livePassUntil(member.signup_pass_expires_at)
            return (
              <li
                key={member.id}
                style={until ? { ...CARD, background: '#edf7f2', borderColor: '#edf7f2' } : CARD}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <b style={{ display: 'block', fontSize: 14 }}>
                      {member.nickname}
                      {member.real_name && (
                        <span style={{ ...MUTED, fontWeight: 400 }}> · {member.real_name}</span>
                      )}
                    </b>
                    <span style={{ ...MUTED, display: 'block' }}>{identityOf(member)}</span>
                    <span style={{ ...MUTED, display: 'block' }}>{weightOf(member)}</span>
                    {/* The date, never a bare "허용됨". The pass is not consumed
                        by a successful signup, so this row keeps reading as
                        granted until the day below actually passes. */}
                    {until && (
                      <span
                        style={{ fontSize: 11, color: '#11805b', display: 'block', marginTop: 3 }}
                      >
                        {formatDay(until)}까지 가입 허용됨
                      </span>
                    )}
                  </span>
                  <button
                    onClick={() => onPass(member)}
                    disabled={busy}
                    style={{
                      minHeight: 44,
                      padding: '0 16px',
                      borderRadius: 13,
                      border: until ? '1px solid #925900' : '1px solid #11805b',
                      background: '#fff',
                      color: until ? '#925900' : '#11805b',
                      fontSize: 13,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {until ? '허용 취소' : '가입 허용'}
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/**
 * Nickname, 실명 and short_name, case-insensitively.
 *
 * Not reusing filterRoster from search.ts: that one is typed to RosterMember and
 * matches on team_role, which this list does not carry. A shared function with
 * two shapes would be worse than two small ones.
 */
function filterMembers(rows: MemberLinkSummary[], term: string): MemberLinkSummary[] {
  const q = term.trim().toLowerCase()
  if (q === '') return rows
  return rows.filter((row) =>
    [row.nickname, row.real_name, row.short_name].some(
      (value) => !!value && value.toLowerCase().includes(q),
    ),
  )
}
