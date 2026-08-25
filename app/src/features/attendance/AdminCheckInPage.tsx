import { useState } from 'react'
import { useParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRoster, markAttendance, STATUS_LABEL, type AttendanceStatus } from './api'
import { AsyncSection } from '../../components/ui/AsyncSection'
import { SaveState } from '../../components/ui/SaveState'

const STATUSES: AttendanceStatus[] = ['present', 'late', 'absent']

export function AdminCheckInPage() {
  const { activityId = '' } = useParams()
  const qc = useQueryClient()
  const [rowState, setRowState] = useState<Record<string, 'idle' | 'saving' | 'saved' | 'error'>>({})

  const query = useQuery({
    queryKey: ['roster', activityId],
    queryFn: () => getRoster(activityId),
    enabled: !!activityId,
  })

  const mark = useMutation({
    mutationFn: markAttendance,
    onMutate: (v) => setRowState((s) => ({ ...s, [v.memberId]: 'saving' })),
    onSuccess: (_d, v) => {
      setRowState((s) => ({ ...s, [v.memberId]: 'saved' }))
      void qc.invalidateQueries({ queryKey: ['roster', activityId] })
    },
    // Deliberately does not revert the row. The legacy screen had no state to
    // revert from and said nothing either way; showing the failure and letting
    // the admin retry beats silently undoing their tap.
    onError: (_e, v) => setRowState((s) => ({ ...s, [v.memberId]: 'error' })),
  })

  return (
    <div style={{ padding: 18 }}>
      <h1 style={{ fontSize: 22, letterSpacing: -0.8 }}>출석 체크</h1>
      <div style={{ marginTop: 16 }}>
        <AsyncSection
          query={query}
          isEmpty={(rows) => rows.length === 0}
          empty="신청자가 없습니다"
          error="명단을 불러오지 못했습니다"
        >
          {(rows) => (
            <div style={{ display: 'grid', gap: 9 }}>
              {rows.map((row) => (
                <div
                  key={row.member_id}
                  style={{
                    padding: 14,
                    border: '1px solid #e1e5ea',
                    borderRadius: 18,
                    background: '#fff',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <b style={{ fontSize: 13 }}>{row.nickname}</b>
                    <SaveState
                      state={rowState[row.member_id] ?? 'idle'}
                      onRetry={
                        row.status
                          ? () =>
                              mark.mutate({
                                activityId,
                                memberId: row.member_id,
                                status: row.status as AttendanceStatus,
                              })
                          : undefined
                      }
                    />
                  </div>
                  <div style={{ display: 'flex', gap: 7, marginTop: 10, flexWrap: 'wrap' }}>
                    {STATUSES.map((s) => (
                      <button
                        key={s}
                        onClick={() =>
                          mark.mutate({ activityId, memberId: row.member_id, status: s })
                        }
                        aria-pressed={row.status === s}
                        style={{
                          // 44px floor: the legacy buttons were ~28px, below the
                          // touch-target minimum for a screen used poolside.
                          minHeight: 44,
                          minWidth: 64,
                          borderRadius: 13,
                          border: row.status === s ? '1px solid #111317' : '1px solid #e1e5ea',
                          background: row.status === s ? '#111317' : '#fff',
                          color: row.status === s ? '#fff' : '#111317',
                          fontSize: 13,
                        }}
                      >
                        {STATUS_LABEL[s]}
                      </button>
                    ))}
                    {row.status === 'late' && (
                      <button
                        onClick={() =>
                          mark.mutate({
                            activityId,
                            memberId: row.member_id,
                            status: 'late',
                            lateFeePaid: !row.late_fee_paid,
                          })
                        }
                        style={{
                          minHeight: 44,
                          borderRadius: 13,
                          border: '1px solid #e1e5ea',
                          background: row.late_fee_paid ? '#fff0d6' : '#fff',
                          color: '#925900',
                          fontSize: 13,
                        }}
                      >
                        {row.late_fee_paid ? '지각비 납부완료' : '지각비 미납'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </AsyncSection>
      </div>
    </div>
  )
}
