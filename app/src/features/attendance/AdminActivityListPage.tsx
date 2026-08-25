import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { AsyncSection } from '../../components/ui/AsyncSection'
import { listActivities } from './api'

export function AdminActivityListPage() {
  const query = useQuery({ queryKey: ['activities'], queryFn: listActivities })

  return (
    <div style={{ padding: 18 }}>
      <h1 style={{ fontSize: 22, letterSpacing: -0.8 }}>출석 관리</h1>
      <div style={{ marginTop: 16 }}>
        <AsyncSection
          query={query}
          isEmpty={(rows) => rows.length === 0}
          empty="등록된 일정이 없습니다"
          error="일정을 불러오지 못했습니다"
        >
          {(rows) => (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 9 }}>
              {rows.map((a) => (
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
          )}
        </AsyncSection>
      </div>
    </div>
  )
}
