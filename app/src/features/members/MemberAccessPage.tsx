import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { SaveState } from '../../components/ui/SaveState'
import { MemberAvatar } from './MemberAvatar'
import {
  getMemberAccessLists,
  ROLE_LABEL,
  setMemberBlocked,
  type MemberAccess,
  type MemberAccessLists,
} from './api'

const CARD = {
  padding: 14,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
} as const

type BlockChange = { memberId: string; blocked: boolean }

/**
 * 회원 내보내기, and its undo.
 *
 * Kept off the approval queue on purpose. That screen decides a pending
 * application, and set_member_status_v1 only touches a row still marked
 * 'pending' (0010:48); this one ends or restores the access of somebody already
 * in. Different question, different blast radius, different RPC.
 */
export function MemberAccessPage() {
  const qc = useQueryClient()
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  // Kept so 다시 시도 resends the decision that failed rather than whichever one
  // was clicked most recently.
  const [pending, setPending] = useState<BlockChange | null>(null)

  const query = useQuery({ queryKey: ['member-access'], queryFn: getMemberAccessLists })

  const change = useMutation({
    mutationFn: (input: BlockChange) => setMemberBlocked(input),
    onMutate: (input) => {
      setPending(input)
      setState('saving')
    },
    onSuccess: async () => {
      setState('saved')
      // Refetched rather than moved in place: the row crosses between two lists
      // and the server is what knows the resulting order.
      await qc.invalidateQueries({ queryKey: ['member-access'] })
      // member_public_v is approved-only, so blocking removes somebody from
      // every roster-shaped screen and restoring puts them back.
      await qc.invalidateQueries({ queryKey: ['roster'] })
      await qc.invalidateQueries({ queryKey: ['member-options'] })
    },
    onError: () => setState('error'),
  })

  const busy = state === 'saving'

  function block(member: MemberAccess) {
    // Names what is lost, and just as importantly what is not. The legacy
    // wording 내보내기 sounds final; this is a suspension, and the 복구 button
    // is on the list right above.
    const confirmed = window.confirm(
      `${member.nickname}님을 내보낼까요?\n\n` +
        '로그인해도 앱을 쓸 수 없게 되고 회원 목록·참석자 명단에서 사라집니다.\n' +
        '기록·출석·신청 내역은 지워지지 않으며 이 화면에서 다시 복구할 수 있습니다.',
    )
    if (!confirmed) return
    change.mutate({ memberId: member.id, blocked: true })
  }

  function restore(member: MemberAccess) {
    // Confirmed too, though it is the safe direction: on a phone it sits a
    // thumb-width from 내보내기, and both are one tap.
    if (!window.confirm(`${member.nickname}님을 다시 승인 상태로 되돌릴까요?`)) return
    change.mutate({ memberId: member.id, blocked: false })
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
          margin: '12px 0 6px',
        }}
      >
        <h1 style={{ fontSize: 22, letterSpacing: -0.8, margin: 0 }}>회원 내보내기</h1>
        <SaveState state={state} onRetry={pending ? () => change.mutate(pending) : undefined} />
      </header>

      <p style={{ fontSize: 12, color: '#6b7178', margin: '0 0 16px', lineHeight: 1.6 }}>
        내보낸 회원은 로그인해도 앱을 쓸 수 없지만 계정과 기록은 그대로 남고 언제든 되돌릴 수
        있습니다. 총관리자와 본인 계정은 대상이 될 수 없습니다.
      </p>

      <AsyncSection
        query={query}
        isEmpty={(lists) => lists.active.length === 0 && lists.blocked.length === 0}
        loading={<Shimmer rows={4} />}
        empty="승인된 회원이 없습니다"
        error="회원 목록을 불러오지 못했습니다"
      >
        {(lists) => <Lists lists={lists} busy={busy} onBlock={block} onRestore={restore} />}
      </AsyncSection>
    </div>
  )
}

function Lists({
  lists,
  busy,
  onBlock,
  onRestore,
}: {
  lists: MemberAccessLists
  busy: boolean
  onBlock: (member: MemberAccess) => void
  onRestore: (member: MemberAccess) => void
}) {
  return (
    <>
      {/* Blocked first when there are any: it is the shorter list, and it is
          what somebody arriving to undo a mistake came for. */}
      {lists.blocked.length > 0 && (
        <section style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 13, color: '#6b7178', fontWeight: 400, margin: '0 0 9px' }}>
            내보낸 회원 {lists.blocked.length}명
          </h2>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 9 }}>
            {lists.blocked.map((member) => (
              <li key={member.id} style={{ ...CARD, background: '#fff0d6', borderColor: '#fff0d6' }}>
                <Row member={member}>
                  <button
                    onClick={() => onRestore(member)}
                    disabled={busy}
                    style={{
                      minHeight: 44,
                      padding: '0 16px',
                      borderRadius: 13,
                      border: '1px solid #925900',
                      background: '#fff',
                      color: '#925900',
                      fontSize: 13,
                    }}
                  >
                    복구
                  </button>
                </Row>
              </li>
            ))}
          </ul>
        </section>
      )}

      <h2 style={{ fontSize: 13, color: '#6b7178', fontWeight: 400, margin: '0 0 9px' }}>
        승인된 회원 {lists.active.length}명
      </h2>
      {lists.active.length === 0 ? (
        <p style={{ ...CARD, fontSize: 13, color: '#6b7178', margin: 0 }}>승인된 회원이 없습니다.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 9 }}>
          {lists.active.map((member) => (
            <li key={member.id} style={CARD}>
              <Row member={member}>
                {/* A master admin is listed but has no button:
                    set_member_blocked_v1 refuses that row — and the caller's own
                    — so offering one would be offering an error. The row stays
                    so the reader can see why. */}
                {member.role === 'master_admin' ? (
                  <span style={{ fontSize: 11, color: '#6b7178' }}>총관리자</span>
                ) : (
                  <button
                    onClick={() => onBlock(member)}
                    disabled={busy}
                    style={{
                      minHeight: 44,
                      padding: '0 16px',
                      borderRadius: 13,
                      border: '1px solid #a33',
                      background: '#fff',
                      color: '#a33',
                      fontSize: 13,
                    }}
                  >
                    내보내기
                  </button>
                )}
              </Row>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

function Row({ member, children }: { member: MemberAccess; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <MemberAvatar member={member} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <b style={{ display: 'block', fontSize: 14 }}>{member.nickname}</b>
        <span style={{ fontSize: 11, color: '#6b7178' }}>
          {member.team_role ?? ROLE_LABEL[member.role]}
        </span>
      </span>
      {children}
    </div>
  )
}
