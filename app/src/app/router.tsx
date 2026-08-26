import { createBrowserRouter, Outlet, ScrollRestoration } from 'react-router'
import { RequireAuth, RequireMasterAdmin, RequireStaff } from './guards'
import { LoginPage, PendingPage } from '../features/auth/LoginPage'
import { SignupPage } from '../features/auth/SignupPage'
import { MyPage } from '../features/profile/MyPage'
import { ApplicationAdminPage } from '../features/schedule/ApplicationAdminPage'
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
import { MemberRecordsPage } from '../features/records/MemberRecordsPage'
import { AdminRecordEditPage } from '../features/records/AdminRecordEditPage'
import { MemberListPage } from '../features/members/MemberListPage'
import { MemberDetailPage } from '../features/members/MemberDetailPage'
import { MemberActivityPage } from '../features/members/MemberActivityPage'
import { MemberApprovalPage } from '../features/members/MemberApprovalPage'
import { MemberRolesPage } from '../features/members/MemberRolesPage'
import { MemberAccessPage } from '../features/members/MemberAccessPage'
import { MemberLinkPage } from '../features/members/MemberLinkPage'
import { MediaFolderListPage } from '../features/media/MediaFolderListPage'
import { MediaFolderPage } from '../features/media/MediaFolderPage'
import { ResourceListPage } from '../features/media/ResourceListPage'
import { MyRacesPage } from '../features/schedule/MyRacesPage'
import { EventHubPage } from '../features/events/EventHubPage'
import { EventRankingPage } from '../features/events/EventRankingPage'
import { ChatPage } from '../features/chat/ChatPage'
import { DmPage } from '../features/chat/DmPage'
import { NotificationSettingsPage } from '../features/push/NotificationSettingsPage'
import { BoardListPage } from '../features/board/BoardListPage'
import { BoardDetailPage } from '../features/board/BoardDetailPage'
import { BoardEditPage } from '../features/board/BoardEditPage'

/**
 * The frame above every route, and the only thing in it is scroll position.
 *
 * A phone app that keeps the last screen's scroll offset drops a member into the
 * middle of the notice they just tapped, because a client-side navigation does
 * not touch the scroll position at all — the browser simply clamps whatever it
 * was to the new document's height. On a short screen that clamps to 0 and looks
 * fixed; on a tall one it does not. Measured before the fix: 마이페이지 scrolled
 * to y=282, tapping 홈 landed on the home screen still at y=282.
 *
 * <ScrollRestoration> is react-router's answer and it draws the distinction that
 * matters: a PUSH has no saved position for its brand-new location key, so it
 * falls through to window.scrollTo(0, 0); a POP finds the key it saved on the
 * way out and restores it. Rolling this by hand as an effect that scrolls on
 * every render gets the first half and silently loses the second.
 *
 * It takes over from the browser (history.scrollRestoration = 'manual'), which
 * is why the back case had to be re-measured rather than assumed: until now the
 * browser was doing that half by itself.
 *
 * The window is what scrolls here — #root is a min-height column with no
 * overflow-y of its own — so scrollTo is aimed at the right thing. If a screen
 * ever becomes its own scroll container this stops working silently.
 *
 * One instance, at the root, per its documentation. Everything is nested under
 * it, including /login and the catch-all, so no route can be added that forgets.
 */
function ScrollFrame() {
  return (
    <>
      <ScrollRestoration />
      <Outlet />
    </>
  )
}

// Access is decided by position in this tree, not by a check inside each screen.
export const router = createBrowserRouter([
  {
    element: <ScrollFrame />,
    children: [
      { path: '/login', element: <LoginPage /> },
      // Outside RequireAuth, and that is the whole point: somebody signing up has no
      // session yet and no members row, so any guard above this route would turn the
      // only way into the club into a redirect back to the login screen they cannot
      // use. It sits beside /login rather than under it for the same reason /pending
      // does — all three are the screens for people the app cannot yet identify.
      { path: '/signup', element: <SignupPage /> },
      { path: '/pending', element: <PendingPage /> },
      {
        element: <RequireAuth />,
        children: [
          { path: '/', element: <HomePage /> },
          // 마이페이지. Every approved member has one and it only ever shows their
          // own row: getMyProfile filters on the session's auth id, and the two
          // write RPCs (set_my_real_name_v1, set_my_avatar_path_v1, both 0027)
          // derive the target from the session rather than taking a member id — so
          // there is no URL that reaches somebody else's profile, and RequireAuth is
          // the whole gate this route needs.
          { path: '/mypage', element: <MyPage /> },
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
          // 상세 기록 and 활동 현황, the two drill-downs off 회원 상세.
          //
          // On RequireAuth rather than RequireStaff, and the reason is that neither
          // set is expressible here. records_read (0004:222-224) admits the member
          // themselves or can_manage_records(), which includes any member whose
          // team_role is '코치' — and CurrentUser carries no team_role, so no guard
          // and no client-side predicate can name that set. RequireStaff would turn
          // a coach away from a screen the database answers for them, and would bar
          // a member from their own rows; both would be the guard contradicting the
          // database rather than agreeing with it.
          //
          // So the tree grants the screens to any approved member, each asks the
          // server the same question its policy asks (can_manage_records / is_staff,
          // both granted to authenticated), and a refusal is printed as a sentence.
          // That is the pattern /schedule/:activityId/edit already follows above.
          { path: '/members/:memberId/records', element: <MemberRecordsPage /> },
          { path: '/members/:memberId/activities/:kind', element: <MemberActivityPage /> },
          { path: '/media', element: <MediaFolderListPage /> },
          { path: '/media/:folderId', element: <MediaFolderPage /> },
          // 자료실. A sibling of /media rather than a child, because its rows are
          // the ones with no folder — /media/:folderId could only reach them
          // through an id that does not exist. Every approved member may upload
          // here (media_files_insert, 0021, matching upstream:2960), so there is no
          // staff-only resource route to guard.
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
              // 활동 취합본. Beside the attendance pair rather than under it: the two
              // answer different questions about the same activity — who applied,
              // and who turned up — and neither is a step in the other.
              //
              // RequireStaff is presentation here as everywhere. applications_read
              // (0001:188-190) hands a non-staff caller only their own rows, so the
              // screen asks is_staff() itself and prints a Korean refusal rather
              // than rendering one member's history as if it were the club's.
              { path: '/admin/applications', element: <ApplicationAdminPage /> },
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
                  // 회원 연결. Master-admin for the strictest reason on this
                  // branch of the tree: link_member_login_v1 moves an auth
                  // account between member rows and deletes the row it came
                  // from. Its neighbours end or grant access; this one decides
                  // whose history an account owns, and there is no undo inside
                  // the app. Both RPCs behind the screen check
                  // is_master_admin() themselves and raise 42501 — verified
                  // against the dev database, where an `admin` who is not a
                  // master was refused — so this guard only keeps people off a
                  // screen whose every button the server would reject.
                  { path: '/members/link', element: <MemberLinkPage /> },
                ],
              },
            ],
          },
          // 자유게시판. Every one of these is RequireAuth and none is
          // RequireStaff, which is the whole shape of his board: the ＋ that
          // opens 글 작성 is unconditional markup (upstream:1279) and applyRole()
          // never touches a board control, so any approved member writes here.
          //
          // Editing is the one narrow permission, and it is narrower than any
          // guard can say — the author of the row at this id, and not staff
          // (upstream:2639 refuses a non-author, and he made no admin case for
          // it). A RequireStaff copy of /board/:postId/edit would be the thing
          // this file keeps warning about: a guard that looks like it decides
          // something while update_board_post_v1 is what actually does. The
          // screen mirrors the RPC instead and prints a Korean refusal.
          //
          // Ranked matching puts the literal /board/new ahead of the sibling
          // /board/:postId, the same trap /notices/new springs.
          { path: '/board', element: <BoardListPage /> },
          { path: '/board/new', element: <BoardEditPage /> },
          { path: '/board/:postId', element: <BoardDetailPage /> },
          { path: '/board/:postId/edit', element: <BoardEditPage /> },
        ],
      },
      { path: '*', element: <div style={{ padding: 24 }}>페이지를 찾을 수 없습니다.</div> },
    ],
  },
])
