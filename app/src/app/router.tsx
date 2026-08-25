import { createBrowserRouter } from 'react-router'
import { RequireAuth, RequireMasterAdmin, RequireStaff } from './guards'
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
import { MemberListPage } from '../features/members/MemberListPage'
import { MemberDetailPage } from '../features/members/MemberDetailPage'
import { MemberApprovalPage } from '../features/members/MemberApprovalPage'
import { MemberRolesPage } from '../features/members/MemberRolesPage'
import { MemberAccessPage } from '../features/members/MemberAccessPage'
import { MediaFolderListPage } from '../features/media/MediaFolderListPage'
import { MediaFolderPage } from '../features/media/MediaFolderPage'
import { ResourceListPage } from '../features/media/ResourceListPage'

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
      { path: '/members', element: <MemberListPage /> },
      { path: '/members/:memberId', element: <MemberDetailPage /> },
      { path: '/media', element: <MediaFolderListPage /> },
      { path: '/media/:folderId', element: <MediaFolderPage /> },
      // 자료실. A sibling of /media rather than a child, because its rows are
      // the ones with no folder — /media/:folderId could only reach them
      // through an id that does not exist. Uploading here is staff-only in the
      // UI but not in RLS (media_files_insert takes any approved member), so
      // there is no staff-only resource route to guard.
      { path: '/files', element: <ResourceListPage /> },
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
          {
            // Nested one level deeper: admitting and rejecting members, and
            // changing roles, are master-admin only — matching the legacy app,
            // which gates approval on isMasterAdmin. Both RPCs refuse an admin
            // in the database, so this guard only keeps them off screens whose
            // every button would fail.
            //
            // Ranked matching puts these literal segments ahead of the sibling
            // /members/:memberId above, so a member typing either URL meets the
            // guard rather than a detail page for an id that reads "approval".
            element: <RequireMasterAdmin />,
            children: [
              { path: '/members/approval', element: <MemberApprovalPage /> },
              { path: '/members/roles', element: <MemberRolesPage /> },
              // 회원 내보내기. Master-admin for the same reason as its
              // neighbours — the legacy screen says 가입 승인·회원
              // 내보내기·권한 지정/해제는 총관리자만 (index.html:1127) — and
              // set_member_blocked_v1 refuses anyone else in the database.
              { path: '/members/blocked', element: <MemberAccessPage /> },
            ],
          },
        ],
      },
    ],
  },
  { path: '*', element: <div style={{ padding: 24 }}>페이지를 찾을 수 없습니다.</div> },
])
