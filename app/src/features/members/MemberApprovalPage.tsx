import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { SaveState } from '../../components/ui/SaveState'
import {
  getApprovalQueue,
  setMemberStatus,
  STATUS_LABEL,
  type ApprovalCandidate,
  type ApprovalQueue,
} from './api'

const CARD = {
  padding: 14,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
} as const

type Decision = { memberId: string; status: 'approved' | 'rejected' }

export function MemberApprovalPage() {
  const qc = useQueryClient()
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  // Kept so 다시 시도 retries the decision that failed rather than whichever one
  // somebody clicked last.
  const [lastDecision, setLastDecision] = useState<Decision | null>(null)

  const query = useQuery({ queryKey: ['approval-queue'], queryFn: getApprovalQueue })

  const decide = useMutation({
    mutationFn: (decision: Decision) => setMemberStatus(decision),
    onMutate: (decision) => {
      setLastDecision(decision)
      setState('saving')
    },
    onSuccess: async () => {
      setState('saved')
      // Refetched rather than patched in place: the row moves between two lists
      // and the server is the only thing that knows the new order.
      await qc.invalidateQueries({ queryKey: ['approval-queue'] })
      // An approval adds somebody to member_public_v, so every roster-shaped
      // screen is now stale.
      await qc.invalidateQueries({ queryKey: ['roster'] })
      await qc.invalidateQueries({ queryKey: ['member-options'] })
    },
    onError: () => setState('error'),
  })

  const busy = state === 'saving'

  function approve(member: ApprovalCandidate) {
    // No confirmation: approving is the expected outcome, and a slip is undone
    // by a 거절 on the same screen.
    decide.mutate({ memberId: member.id, status: 'approved' })
  }

  function reject(member: ApprovalCandidate) {
    if (!window.confirm(`${member.nickname}님의 가입을 거절할까요?`)) return
    decide.mutate({ memberId: member.id, status: 'rejected' })
  }

  return (
    <div style={{ padding: 18, background: '#f5f6f8', minHeight: '100vh' }}>
      <Link to="/members" style={{ fontSize: 12, color: '#6b7178', textDecoration: 'none' }}>
        ← 회원
      </Link>

      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 9,
          margin: '12px 0 16px',
        }}
      >
        <h1 style={{ fontSize: 22, letterSpacing: -0.8, margin: 0 }}>가입 승인</h1>
        <SaveState
          state={state}
          onRetry={lastDecision ? () => decide.mutate(lastDecision) : undefined}
        />
      </header>

      <AsyncSection
        query={query}
        isEmpty={(queue) => queue.pending.length === 0 && queue.processed.length === 0}
        loading={<Shimmer rows={3} />}
        empty="승인을 기다리는 회원이 없습니다"
        error="승인 대기 목록을 불러오지 못했습니다"
      >
        {(queue) => <Queue queue={queue} busy={busy} onApprove={approve} onReject={reject} />}
      </AsyncSection>
    </div>
  )
}

function Queue({
  queue,
  busy,
  onApprove,
  onReject,
}: {
  queue: ApprovalQueue
  busy: boolean
  onApprove: (member: ApprovalCandidate) => void
  onReject: (member: ApprovalCandidate) => void
}) {
  return (
    <>
      <h2 style={{ fontSize: 13, color: '#6b7178', fontWeight: 400, margin: '0 0 9px' }}>
        승인 대기 {queue.pending.length}명
      </h2>

      {queue.pending.length === 0 ? (
        <p style={{ ...CARD, fontSize: 13, color: '#6b7178', margin: 0 }}>
          현재 승인 대기 회원이 없습니다.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 9 }}>
          {queue.pending.map((member) => (
            <li key={member.id} style={CARD}>
              <Applicant member={member} />
              <div style={{ display: 'flex', gap: 7, marginTop: 12 }}>
                <button
                  onClick={() => onApprove(member)}
                  disabled={busy}
                  style={{
                    flex: 1,
                    minHeight: 44,
                    borderRadius: 13,
                    border: 'none',
                    background: busy ? '#e1e5ea' : '#11805b',
                    color: busy ? '#6b7178' : '#fff',
                    fontSize: 13,
                  }}
                >
                  승인
                </button>
                <button
                  onClick={() => onReject(member)}
                  disabled={busy}
                  style={{
                    flex: 1,
                    minHeight: 44,
                    borderRadius: 13,
                    border: '1px solid #a33',
                    background: '#fff',
                    color: '#a33',
                    fontSize: 13,
                  }}
                >
                  거절
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {queue.processed.length > 0 && (
        <section style={{ marginTop: 24 }}>
          {/* Kept from the legacy screen. It is what tells a staffer their click
              landed on the person they meant, after the row has left the queue
              above. */}
          <h2 style={{ fontSize: 13, color: '#6b7178', fontWeight: 400, margin: '0 0 9px' }}>
            최근 처리한 회원
          </h2>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 9 }}>
            {queue.processed.map((member) => (
              <li key={member.id} style={{ ...CARD, display: 'flex', alignItems: 'center', gap: 9 }}>
                <b style={{ fontSize: 14, flex: 1 }}>{member.nickname}</b>
                <span
                  style={{
                    padding: '2px 8px',
                    borderRadius: 999,
                    fontSize: 11,
                    background: member.status === 'approved' ? '#edf7f2' : '#fff0f0',
                    color: member.status === 'approved' ? '#11805b' : '#a33',
                  }}
                >
                  {STATUS_LABEL[member.status]}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

// created_at is a real timestamp, unlike join_date_text, so it is the one field
// here worth formatting rather than printing verbatim.
const formatApplied = (iso: string) =>
  new Date(iso).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' })

function Applicant({ member }: { member: ApprovalCandidate }) {
  const details: [string, string | null][] = [
    ['실명', member.real_name],
    ['가입일', member.join_date_text],
    ['강습', member.lesson_level],
    ['수력', member.swim_experience],
    ['가입 사유', member.join_reason],
  ]

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 15 }}>{member.nickname}</b>
        <span style={{ fontSize: 11, color: '#6b7178' }}>
          {formatApplied(member.created_at)} 신청
        </span>
      </div>
      <dl style={{ display: 'grid', gap: 6, margin: '10px 0 0' }}>
        {details
          // A field nobody filled in is dropped rather than shown as a dash: the
          // question on this card is whether to let somebody in, and empty rows
          // only make it longer to read.
          .filter((entry): entry is [string, string] => !!entry[1])
          .map(([label, value]) => (
            <div key={label} style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
              <dt style={{ fontSize: 11, color: '#6b7178', width: 60, flexShrink: 0 }}>{label}</dt>
              <dd
                style={{ fontSize: 12, margin: 0, flex: 1, minWidth: 0, wordBreak: 'break-word' }}
              >
                {value}
              </dd>
            </div>
          ))}
      </dl>
    </>
  )
}
