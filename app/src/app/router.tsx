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
import { ActivityEditPage } from '../features/schedule/ActivityEditPage'
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
import { MyRacesPage } from '../features/schedule/MyRacesPage'
import { EventHubPage } from '../features/events/EventHubPage'
import { EventRankingPage } from '../features/events/EventRankingPage'
import { ChatPage } from '../features/chat/ChatPage'
import { DmPage } from '../features/chat/DmPage'
import { NotificationSettingsPage } from '../features/push/NotificationSettingsPage'

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
      // Creating and editing an activity moved out from under RequireStaff when
      // 0015 opened 기타 to every approved member. Neither job is staff-only any
      // more, and neither is member-only: who may write depends on the kind of
      // the row and on who filed it, which no position in this tree can say. The
      // four RLS policies say it instead, and ActivityEditPage mirrors them so a
      // member meets a sentence rather than a form that cannot save.
      //
      // A staff-guarded duplicate of these two routes was the alternative, and
      // it would be the thing this project keeps warning about: a guard that
      // looks like it decides something while the real decision is elsewhere.
      //
      // Ranked matching puts the literal /schedule/new ahead of the sibling
      // /schedule/:activityId below, the same trap /notices/new springs.
      { path: '/schedule/new', element: <ActivityEditPage /> },
      // 나의 대회 신청 내역. A literal sibling of /schedule/:activityId, so
      // ranked matching is what keeps it from being read as an activity id —
      // the same reason /schedule/new above is safe next to it. Every approved
      // member reads their own history and race_my_history_v1 takes no member
      // id, so RequireAuth is the whole gate: the server cannot be asked for
      // somebody else's races.
      { path: '/schedule/mine', element: <MyRacesPage /> },
      { path: '/schedule/:activityId', element: <ActivityDetailPage /> },
      { path: '/schedule/:activityId/edit', element: <ActivityEditPage /> },
      // 이벤트 랭킹. Readable by any approved member, which is what the
      // president's app does — the RPC refuses anyone else in the database, so
      // this guard keeps nobody out who the server would have answered.
      { path: '/events', element: <EventHubPage /> },
      { path: '/events/:kind', element: <EventRankingPage /> },
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
      { path: '/chat', element: <ChatPage /> },
      // A child of /chat rather than a sibling of it, because there is no
      // ambiguity to avoid here: /chat/dm/:memberId shares no segment shape
      // with anything else, unlike /notices/new against /notices/:noticeId.
      // Reading a dm is guarded by messages_read (0005) and sending by
      // send_message_v1, so RequireAuth is the whole gate this route needs.
      { path: '/chat/dm/:memberId', element: <DmPage /> },
      // 알림 설정. Every approved member manages their own devices, and
      // push_subscriptions_self (0004) confines each of them to their own rows.
      { path: '/settings/notifications', element: <NotificationSettingsPage /> },
      {
        element: <RequireStaff />,
        children: [
          { path: '/admin/attendance', element: <AdminActivityListPage /> },
          { path: '/admin/attendance/:activityId', element: <AdminCheckInPage /> },
          // Under /admin so it shares no segment shape with /records: a member
          // typing the URL meets RequireStaff rather than a sibling member route
          // that ranked matching might award them instead. Filing a result stays
          // genuinely staff-only — can_manage_records() is what decides it —
          // unlike the schedule editor, which 0015 opened to every member.
          { path: '/admin/records/new', element: <AdminRecordEditPage /> },
          // 결과지 업로드. Beside 기록 추가 rather than under it: the same job,
          // a file instead of a form. RequireStaff is presentation here as
          // everywhere — upsert_record() checks can_manage_records() itself, so
          // the screen cannot file anything the database would not accept.
          //
          // Worth knowing the two gates are not the same set: can_manage_records()
          // (0004:159-169) also admits a member whose team_role is 코치, while
          // is_staff() does not, so a coach who is not an admin can be refused
          // this screen and still be allowed the write behind it.
          //
          // The only lazy route in the tree, and the reason is SheetJS: it is
          // ~900kB, which is larger than the rest of this app put together.
          // Imported statically it would land in the main bundle and every
          // member would download a parser for a screen they cannot open, on a
          // phone, before seeing the notice list. `lazy` fetches it when a
          // staffer actually opens the screen.
          {
            path: '/admin/records/upload',
            lazy: async () => ({
              Component: (await import('../features/records/AdminRecordUploadPage'))
                .AdminRecordUploadPage,
            }),
          },
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
