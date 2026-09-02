import { useState } from 'react'
import { useParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  explainMarkNameFailure,
  getRoster,
  markAttendance,
  markNameAttendance,
  rosterKey,
  STATUS_LABEL,
  type AttendanceStatus,
  type RosterRow,
} from './api'
import { AsyncSection } from '../../components/ui/AsyncSection'
import { SaveState } from '../../components/ui/SaveState'

const STATUSES: AttendanceStatus[] = ['present', 'late', 'absent']

export function AdminCheckInPage() {
  const { activityId = '' } = useParams()
  const qc = useQueryClient()
  // Keyed by activity AND row, not row alone. This component stays mounted when
  // the route changes from one activity to another, so a bare row key would let
  // the previous activity's 저장됨 — or its 오류, whose 다시 시도 button fires
  // against whatever activity is on screen now — paint on the new roster.
  const [rowState, setRowState] = useState<Record<string, 'idle' | 'saving' | 'saved' | 'error'>>({})
  const stateKey = (row: RosterRow) => `${activityId}:${rosterKey(row)}`

  const query = useQuery({
    queryKey: ['roster', activityId],
    queryFn: () => getRoster(activityId),
    enabled: !!activityId,
  })

  // Takes the whole row rather than an id, and dispatches on whether that row
  // has a member behind it. Two RPCs, one gesture: the admin taps 출석 and does
  // not need to know whether this person has an account.
  //
  // The dispatch lives here rather than in api.ts on purpose. `markAttendance`
  // and `markNameAttendance` mirror the two database entry points exactly, and
  // collapsing them into one "either/or" call is what 0051's comment argues
  // against — a caller supplying neither would silently take a branch.
  const mark = useMutation({
    mutationFn: (v: { row: RosterRow; status: AttendanceStatus; lateFeePaid?: boolean }) =>
      v.row.member_id === null
        ? markNameAttendance({
            activityId,
            displayName: v.row.nickname,
            status: v.status,
            lateFeePaid: v.lateFeePaid,
          })
        : markAttendance({
            activityId,
            memberId: v.row.member_id,
            status: v.status,
            lateFeePaid: v.lateFeePaid,
          }),
    // Keyed through stateKey, never by member id: every name-only row has null
    // there, so an id-keyed map would collapse all of them onto one entry and
    // paint one person's spinner on everybody else's row.
    onMutate: (v) => setRowState((s) => ({ ...s, [stateKey(v.row)]: 'saving' })),
    onSuccess: (_d, v) => {
      setRowState((s) => ({ ...s, [stateKey(v.row)]: 'saved' }))
      void qc.invalidateQueries({ queryKey: ['roster', activityId] })
      // 출석 배지 and 월간 활동 요약 are derived from exactly these rows, so a
      // correction that drops somebody below a threshold has to reach them.
      // Only this browser's cache, of course — the member's own device refetches
      // on its next visit, which is the reason nothing is stored server-side.
      void qc.invalidateQueries({ queryKey: ['my-achievement'] })
      void qc.invalidateQueries({ queryKey: ['my-monthly-activity'] })
    },
    // Deliberately does not revert the row. The legacy screen had no state to
    // revert from and said nothing either way; showing the failure and letting
    // the admin retry beats silently undoing their tap.
    onError: (_e, v) => setRowState((s) => ({ ...s, [stateKey(v.row)]: 'error' })),
  })

  // 명단에 없는 사람 — the walk-in who never made an account, and every name on
  // the club's paper registers from before the app existed. Until 0051 there was
  // nowhere to put them: attendance.member_id was a NOT NULL foreign key, so the
  // admin's only options were to invent an account or lose the mark.
  const [newName, setNewName] = useState('')
  const trimmedNewName = newName.trim()
  const addByName = useMutation({
    mutationFn: () =>
      markNameAttendance({ activityId, displayName: trimmedNewName, status: 'present' }),
    onSuccess: () => {
      setNewName('')
      void qc.invalidateQueries({ queryKey: ['roster', activityId] })
    },
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
                  key={rosterKey(row)}
                  style={{
                    padding: 14,
                    border: '1px solid #e1e5ea',
                    borderRadius: 18,
                    background: '#fff',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <b style={{ fontSize: 13 }}>{row.nickname}</b>
                    {row.member_id === null && (
                      // Says why this person looks different before anybody has
                      // to guess: no avatar, no profile link, and a name that
                      // came off a paper register rather than out of `members`.
                      <span
                        style={{
                          fontSize: 11,
                          color: '#6b7178',
                          border: '1px solid #e1e5ea',
                          borderRadius: 999,
                          padding: '2px 7px',
                        }}
                      >
                        미가입
                      </span>
                    )}
                    <SaveState
                      state={rowState[stateKey(row)] ?? 'idle'}
                      onRetry={
                        row.status
                          ? () => mark.mutate({ row, status: row.status as AttendanceStatus })
                          : undefined
                      }
                    />
                  </div>
                  <div style={{ display: 'flex', gap: 7, marginTop: 10, flexWrap: 'wrap' }}>
                    {STATUSES.map((s) => (
                      <button
                        key={s}
                        onClick={() => mark.mutate({ row, status: s })}
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
                            row,
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

        <div
          style={{
            marginTop: 14,
            padding: 14,
            border: '1px solid #e1e5ea',
            borderRadius: 18,
            background: '#fff',
          }}
        >
          <label htmlFor="roster-add-name" style={{ display: 'block', fontSize: 12, color: '#6b7178' }}>
            명단에 없는 사람 추가
          </label>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input
              id="roster-add-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="이름"
              style={{
                flex: 1,
                minHeight: 44,
                padding: 12,
                borderRadius: 13,
                border: '1px solid #e1e5ea',
                // 16px, and it has to be 16px: iOS Safari zooms the page in
                // when a focused input is any smaller. components.css:719 says so
                // for the CSS controls; this inline one has to say it too.
                fontSize: 16,
                fontFamily: 'inherit',
                boxSizing: 'border-box',
              }}
            />
            <button
              onClick={() => addByName.mutate()}
              disabled={trimmedNewName === '' || addByName.isPending}
              style={{
                minHeight: 44,
                minWidth: 72,
                borderRadius: 13,
                border: '1px solid #111317',
                background: trimmedNewName === '' ? '#f2f3f5' : '#111317',
                color: trimmedNewName === '' ? '#9aa0a6' : '#fff',
                fontSize: 13,
              }}
            >
              {addByName.isPending ? '추가 중' : '출석 추가'}
            </button>
          </div>
          <p style={{ fontSize: 12, color: '#6b7178', margin: '8px 0 0', lineHeight: 1.5 }}>
            계정이 없는 참가자를 이름으로 기록합니다. 기록만 남고 출석왕·배지 집계에는 들어가지
            않습니다.
          </p>
          {addByName.isError && (
            // Branched by SQLSTATE rather than collapsed into one sentence.
            // attendance_mark_name_v1 raises three different things, and telling
            // a non-staff admin that the NAME is the problem sends them off to
            // rename somebody. Same shape as schedule/enrolment.ts.
            <p role="alert" style={{ fontSize: 12, color: '#a33', margin: '8px 0 0' }}>
              {explainMarkNameFailure(addByName.error)}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
