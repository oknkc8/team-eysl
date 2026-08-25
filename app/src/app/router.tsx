import { createBrowserRouter } from 'react-router'
import { RequireAuth, RequireStaff } from './guards'
import { LoginPage, PendingPage } from '../features/auth/LoginPage'
import { HomePage } from '../features/home/HomePage'
import { MyAttendancePage } from '../features/attendance/MyAttendancePage'
import { AdminActivityListPage } from '../features/attendance/AdminActivityListPage'
import { AdminCheckInPage } from '../features/attendance/AdminCheckInPage'
import { NoticeListPage } from '../features/notices/NoticeListPage'
import { NoticeDetailPage } from '../features/notices/NoticeDetailPage'
import { NoticeEditPage } from '../features/notices/NoticeEditPage'
import { ScheduleListPage } from '../features/schedule/ScheduleListPage'
import { ActivityDetailPage } from '../features/schedule/ActivityDetailPage'
import { AdminActivityEditPage } from '../features/schedule/AdminActivityEditPage'
import { MyRecordsPage } from '../features/records/MyRecordsPage'
import { AdminRecordEditPage } from '../features/records/AdminRecordEditPage'

// Access is decided by position in this tree, not by a check inside each screen.
export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/pending', element: <PendingPage /> },
  {
    element: <RequireAuth />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/attendance', element: <MyAttendancePage /> },
      { path: '/notices', element: <NoticeListPage /> },
      { path: '/notices/:noticeId', element: <NoticeDetailPage /> },
      { path: '/schedule', element: <ScheduleListPage /> },
      { path: '/schedule/:activityId', element: <ActivityDetailPage /> },
      { path: '/records', element: <MyRecordsPage /> },
      {
        element: <RequireStaff />,
        children: [
          { path: '/admin/attendance', element: <AdminActivityListPage /> },
          { path: '/admin/attendance/:activityId', element: <AdminCheckInPage /> },
          // Under /admin for the same reason the schedule editor is: a member
          // typing the URL meets RequireStaff rather than a sibling member
          // route that ranked matching might award them instead.
          { path: '/admin/records/new', element: <AdminRecordEditPage /> },
          // Under /admin rather than beside /schedule/:activityId, so creating
          // and editing cannot be reached by a member typing a URL that ranked
          // matching might award to the sibling detail route.
          { path: '/admin/schedule/new', element: <AdminActivityEditPage /> },
          { path: '/admin/schedule/:activityId/edit', element: <AdminActivityEditPage /> },
          // Ranked matching puts the literal /notices/new ahead of the sibling
          // /notices/:noticeId above, so the staff branch wins despite being
          // declared later — a member who types the URL lands on RequireStaff.
          { path: '/notices/new', element: <NoticeEditPage /> },
          { path: '/notices/:noticeId/edit', element: <NoticeEditPage /> },
        ],
      },
    ],
  },
  { path: '*', element: <div style={{ padding: 24 }}>페이지를 찾을 수 없습니다.</div> },
])
