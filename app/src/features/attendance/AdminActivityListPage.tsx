import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { listActivities } from './api'

export function AdminActivityListPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['activities'],
    queryFn: listActivities,
  })

  if (isLoading) return <div style={{ padding: 24 }}>불러오는 중…</div>
  if (error) return <div style={{ padding: 24, color: '#a33' }}>일정을 불러오지 못했습니다.</div>
  if (!data?.length) return <div style={{ padding: 24, color: '#6b7178' }}>등록된 일정이 없습니다.</div>

  return (
    <div style={{ padding: 18 }}>
      <h1 style={{ fontSize: 22, letterSpacing: -0.8 }}>출석 관리</h1>
      <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 9, marginTop: 16 }}>
        {data.map((a) => (
          <li key={a.id}>
            <Link
              to={`/admin/attendance/${a.id}`}
              style={{
                display: 'block',
                padding: 14,
                border: '1px solid #e1e5ea',
                borderRadius: 18,
                background: '#fff',
                textDecoration: 'none',
                color: '#111317',
              }}
            >
              <b style={{ fontSize: 13 }}>{a.title}</b>
              <p style={{ fontSize: 11, color: '#6b7178', margin: '4px 0 0' }}>
                {a.activity_date} · {a.place ?? '-'}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
