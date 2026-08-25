import { createBrowserRouter } from 'react-router'
import { RequireAuth, RequireStaff } from './guards'
import { LoginPage, PendingPage } from '../features/auth/LoginPage'
import { HomePage } from '../features/home/HomePage'
import { MyAttendancePage } from '../features/attendance/MyAttendancePage'
import { AdminActivityListPage } from '../features/attendance/AdminActivityListPage'
import { AdminCheckInPage } from '../features/attendance/AdminCheckInPage'

// Access is decided by position in this tree, not by a check inside each screen.
export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/pending', element: <PendingPage /> },
  {
    element: <RequireAuth />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/attendance', element: <MyAttendancePage /> },
      {
        element: <RequireStaff />,
        children: [
          { path: '/admin/attendance', element: <AdminActivityListPage /> },
          { path: '/admin/attendance/:activityId', element: <AdminCheckInPage /> },
        ],
      },
    ],
  },
  { path: '*', element: <div style={{ padding: 24 }}>페이지를 찾을 수 없습니다.</div> },
])
