import { useQuery } from '@tanstack/react-query'
import { getMyHistory, STATUS_LABEL } from './api'

export function MyAttendancePage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['my-attendance'],
    queryFn: getMyHistory,
  })

  if (isLoading) return <div style={{ padding: 24 }}>불러오는 중…</div>
  if (error) return <div style={{ padding: 24, color: '#a33' }}>출석 기록을 불러오지 못했습니다.</div>

  const rows = data ?? []
  const present = rows.filter((r) => r.status === 'present' || r.status === 'late').length
  const late = rows.filter((r) => r.status === 'late').length

  return (
    <div style={{ padding: 18 }}>
      <h1 style={{ fontSize: 22, letterSpacing: -0.8 }}>내 출석</h1>
      <div style={{ display: 'flex', gap: 9, marginTop: 16 }}>
        <Stat label="누적 출석" value={present} />
        <Stat label="누적 지각" value={late} />
      </div>
      {rows.length === 0 ? (
        <p style={{ color: '#6b7178', fontSize: 14, marginTop: 20 }}>아직 출석 기록이 없습니다.</p>
      ) : (
        <div style={{ display: 'grid', gap: 9, marginTop: 16 }}>
          {rows.map((r) => (
            <div
              key={r.activity_id}
              style={{
                padding: 14,
                border: '1px solid #e1e5ea',
                borderRadius: 18,
                background: '#fff',
                display: 'flex',
                justifyContent: 'space-between',
              }}
            >
              <span style={{ fontSize: 13 }}>
                {r.activity_date} {r.title}
              </span>
              <span style={{ fontSize: 12, color: '#11805b' }}>{STATUS_LABEL[r.status]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        flex: 1,
        padding: 14,
        border: '1px solid #e1e5ea',
        borderRadius: 18,
        background: '#fff',
        textAlign: 'center',
      }}
    >
      <strong style={{ fontSize: 22 }}>{value}</strong>
      <div style={{ fontSize: 11, color: '#6b7178' }}>{label}</div>
    </div>
  )
}
