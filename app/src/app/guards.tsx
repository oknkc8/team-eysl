import { Navigate, Outlet, useLocation } from 'react-router'
import { useCurrentUser } from '../features/auth/useCurrentUser'
import { isStaff } from '../features/auth/schema'

function Loading() {
  return <div style={{ padding: 24, color: '#858b94' }}>불러오는 중…</div>
}

// Every authenticated route descends from this, so a new screen is guarded by
// where it sits in the tree. The legacy router checked a role inside only two
// of six admin screens and hid the rest by not rendering a drawer link.
export function RequireAuth() {
  const { user, isLoading, session } = useCurrentUser()
  const location = useLocation()

  // Never redirect while the session is still resolving — doing so signs people
  // out on every refresh.
  if (isLoading) return <Loading />
  if (!session) return <Navigate to="/login" replace state={{ from: location }} />
  if (!user) return <Loading />
  if (user.status !== 'approved') return <Navigate to="/pending" replace />

  return <Outlet />
}

export function RequireStaff() {
  const { user, isLoading } = useCurrentUser()

  if (isLoading) return <Loading />
  if (!isStaff(user)) return <Navigate to="/" replace />

  return <Outlet />
}
