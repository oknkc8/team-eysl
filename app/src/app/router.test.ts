import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { matchRoutes, type RouteObject } from 'react-router'

// Importing the router reaches the Supabase client, which validates env at
// module load — so the values are stubbed before the dynamic import, the same
// way env.test.ts does it.
let router: (typeof import('./router'))['router']
let RequireAuth: (typeof import('./guards'))['RequireAuth']
let RequireStaff: (typeof import('./guards'))['RequireStaff']
let RequireMasterAdmin: (typeof import('./guards'))['RequireMasterAdmin']

beforeAll(async () => {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://ourdevproject.supabase.co')
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test')
  ;({ router } = await import('./router'))
  ;({ RequireAuth, RequireStaff, RequireMasterAdmin } = await import('./guards'))
})

afterAll(() => vi.unstubAllEnvs())

const NOTICE_ID = '00000000-0000-4000-8000-000000000001'
const ACTIVITY_ID = '00000000-0000-4000-8000-000000000002'
const MEMBER_ID = '00000000-0000-4000-8000-000000000003'
const FOLDER_ID = '00000000-0000-4000-8000-000000000004'
const POST_ID = '00000000-0000-4000-8000-000000000005'

/**
 * The guards and the screen a path lands on, in order.
 *
 * The pathless <ScrollFrame> root that every route now hangs from is dropped:
 * it decides scroll position and nothing else, so it is not part of what these
 * tests are about, and leaving it in would put a meaningless entry at the head
 * of all forty expectations. Every real leaf in this tree declares a path, so
 * the only thing this filter can remove is a layout route.
 */
function guardsFor(pathname: string) {
  const matches = matchRoutes(router.routes as RouteObject[], pathname) ?? []
  return matches
    .map((m) => {
      const element = m.route.element as { type?: unknown } | undefined
      if (element?.type === RequireMasterAdmin) return 'master'
      if (element?.type === RequireStaff) return 'staff'
      if (element?.type === RequireAuth) return 'auth'
      return m.route.path ?? 'layout'
    })
    .filter((label) => label !== 'layout')
}

describe('signup is reachable without a session', () => {
  // The one route in this tree that must NOT be guarded. A person signing up has
  // no session and no members row, so RequireAuth would send them to /login —
  // the screen they cannot use, because they are not a member yet. Putting a
  // guard here turns the only way into the club into a redirect loop, which is
  // exactly the state the app was in before this route existed.
  it('puts /signup outside RequireAuth entirely', () => {
    expect(guardsFor('/signup')).toEqual(['/signup'])
  })

  it('never sends /signup through any guard', () => {
    const guards = guardsFor('/signup')
    expect(guards).not.toContain('auth')
    expect(guards).not.toContain('staff')
    expect(guards).not.toContain('master')
  })

  // Its two neighbours for people the app cannot yet identify. All three have to
  // stay reachable without a session or none of them can do their job.
  it('keeps /login and /pending unguarded beside it', () => {
    expect(guardsFor('/login')).toEqual(['/login'])
    expect(guardsFor('/pending')).toEqual(['/pending'])
  })

  it('does not fall through to the catch-all', () => {
    expect(guardsFor('/signup')).not.toContain('*')
  })
})

describe('마이페이지 is guarded by tree position', () => {
  // RequireAuth and nothing more. getMyProfile filters on the session's auth id
  // and both write RPCs (set_my_real_name_v1, set_my_avatar_path_v1) derive the
  // target from the session rather than accepting a member id, so there is no
  // URL that reaches somebody else's profile for a guard to protect.
  it('puts /mypage on RequireAuth only', () => {
    expect(guardsFor('/mypage')).toEqual(['auth', '/mypage'])
  })

  it('does not put a member’s own profile behind a staff guard', () => {
    expect(guardsFor('/mypage')).not.toContain('staff')
    expect(guardsFor('/mypage')).not.toContain('master')
  })

  // /members/:memberId is the other profile-shaped route. If it ever answered
  // for this one, 마이페이지 would open a member detail page for an id that
  // reads "mypage".
  it('is not swallowed by the member detail route', () => {
    expect(guardsFor('/mypage')).not.toContain('/members/:memberId')
  })
})

describe('활동 취합본 is guarded by tree position', () => {
  it('puts /admin/applications behind RequireStaff', () => {
    expect(guardsFor('/admin/applications')).toEqual(['auth', 'staff', '/admin/applications'])
  })

  // Staff, not master admin: reading who applied is what every 운영진 does to
  // run a session, and applications_read (0001:188-190) draws the same line with
  // is_staff(). The screen asks the server the same question before it claims
  // the list is the club's.
  it('does not require master admin to read an application list', () => {
    expect(guardsFor('/admin/applications')).not.toContain('master')
  })

  // A sibling of the attendance pair, not a child of it — the two answer
  // different questions about the same activity.
  it('is not swallowed by the attendance routes', () => {
    expect(guardsFor('/admin/applications')).not.toContain('/admin/attendance')
    expect(guardsFor('/admin/applications')).not.toContain('/admin/attendance/:activityId')
  })
})

describe('notice routes are guarded by tree position', () => {
  // /notices/new and /notices/:noticeId are siblings under different guards, so
  // which one wins is decided by ranked matching rather than by declaration
  // order. If the dynamic route ever won, a member could reach the staff-only
  // editor and a staff member's "새 공지" button would open a broken detail page.
  it('sends /notices/new through RequireStaff, not the detail route', () => {
    expect(guardsFor('/notices/new')).toEqual(['auth', 'staff', '/notices/new'])
  })

  it('keeps the detail route on RequireAuth only', () => {
    expect(guardsFor(`/notices/${NOTICE_ID}`)).toEqual(['auth', '/notices/:noticeId'])
  })

  it('puts the edit route behind RequireStaff', () => {
    expect(guardsFor(`/notices/${NOTICE_ID}/edit`)).toEqual([
      'auth',
      'staff',
      '/notices/:noticeId/edit',
    ])
  })

  it('puts the list behind RequireAuth', () => {
    expect(guardsFor('/notices')).toEqual(['auth', '/notices'])
  })
})

describe('schedule routes are guarded by tree position', () => {
  it('lets any approved member reach the list and one activity', () => {
    expect(guardsFor('/schedule')).toEqual(['auth', '/schedule'])
    expect(guardsFor(`/schedule/${ACTIVITY_ID}`)).toEqual(['auth', '/schedule/:activityId'])
  })

  // /schedule/new is a literal sibling of the dynamic /schedule/:activityId, so
  // which one wins is decided by ranked matching rather than declaration order —
  // the trap /notices/new springs. If the dynamic route won, "기타 등록" would
  // open a detail page for an activity whose id reads "new".
  it('sends /schedule/new to the editor, not the detail route', () => {
    expect(guardsFor('/schedule/new')).toEqual(['auth', '/schedule/new'])
    expect(guardsFor('/schedule/new')).not.toContain('/schedule/:activityId')
  })

  // Creating and editing sit on RequireAuth rather than RequireStaff since 0015:
  // any approved member may file a 기타 and its creator alone may change it, and
  // neither fact is something a position in the route tree can express. The four
  // RLS policies express it; canEditActivity() only decides what renders.
  it('keeps creating and editing an activity on RequireAuth, not RequireStaff', () => {
    expect(guardsFor('/schedule/new')).not.toContain('staff')
    expect(guardsFor(`/schedule/${ACTIVITY_ID}/edit`)).toEqual([
      'auth',
      '/schedule/:activityId/edit',
    ])
  })

  // The staff-only pair these replaced. Leaving them mounted would have meant
  // two URLs for one screen, one of them behind a guard that no longer decides
  // anything — which is the shape this project keeps warning about.
  it('no longer answers the retired /admin/schedule paths', () => {
    expect(guardsFor('/admin/schedule/new')).toEqual(['*'])
    expect(guardsFor(`/admin/schedule/${ACTIVITY_ID}/edit`)).toEqual(['*'])
  })
})

describe('record routes are guarded by tree position', () => {
  it('lets any approved member read their own records', () => {
    expect(guardsFor('/records')).toEqual(['auth', '/records'])
  })

  // Filing a result is staff-only in the tree, and can_manage_records() is what
  // enforces it in the database — upsert_record() raises 42501 for anyone else,
  // so reaching this screen is not the same as being allowed to write.
  it('puts filing a record behind RequireStaff', () => {
    expect(guardsFor('/admin/records/new')).toEqual(['auth', 'staff', '/admin/records/new'])
  })

  it('puts the sheet upload behind RequireStaff too', () => {
    expect(guardsFor('/admin/records/upload')).toEqual(['auth', 'staff', '/admin/records/upload'])
  })

  it('does not let the member records route swallow the admin path', () => {
    expect(guardsFor('/admin/records/new')).not.toContain('/records')
    expect(guardsFor('/admin/records/upload')).not.toContain('/records')
  })
})

describe('member routes are guarded by tree position', () => {
  it('lets any approved member read the roster and one member', () => {
    expect(guardsFor('/members')).toEqual(['auth', '/members'])
    expect(guardsFor(`/members/${MEMBER_ID}`)).toEqual(['auth', '/members/:memberId'])
  })

  // /members/approval and /members/roles are literal siblings of the dynamic
  // /members/:memberId, so which wins is decided by ranked matching rather than
  // declaration order — the same trap /notices/new sprang. If the dynamic route
  // won, a member could reach the approval queue by typing a URL.
  // Master-admin, not merely staff: the legacy app gates approval on
  // isMasterAdmin, and set_member_status_v1() refuses an admin in the database.
  // Widening who may admit members is the president's decision, not ours.
  it('puts the approval queue behind RequireMasterAdmin, not the detail route', () => {
    expect(guardsFor('/members/approval')).toEqual([
      'auth',
      'staff',
      'master',
      '/members/approval',
    ])
  })

  it('puts role management behind RequireMasterAdmin', () => {
    expect(guardsFor('/members/roles')).toEqual(['auth', 'staff', 'master', '/members/roles'])
  })

  // Blocking is what actually ends somebody's access — current_member_id()
  // stops answering for them — so it sits with approval and roles rather than
  // with the merely staff-only screens. set_member_blocked_v1 refuses an admin
  // in the database, matching the legacy gate at index.html:1127.
  it('puts 회원 내보내기 behind RequireMasterAdmin', () => {
    expect(guardsFor('/members/blocked')).toEqual(['auth', 'staff', 'master', '/members/blocked'])
  })

  // An admin who is not the master must meet the master guard rather than the
  // member detail screen, so the redirect is the one this route intends.
  it('does not let the member detail route swallow any admin path', () => {
    expect(guardsFor('/members/approval')).not.toContain('/members/:memberId')
    expect(guardsFor('/members/roles')).not.toContain('/members/:memberId')
    expect(guardsFor('/members/blocked')).not.toContain('/members/:memberId')
  })

  // The two drill-downs deliberately do NOT sit behind RequireStaff, and the
  // reason is that neither entitlement is expressible in this tree.
  // records_read (0004:222-224) admits the member themselves or
  // can_manage_records(), which includes a member whose team_role is '코치' —
  // and CurrentUser carries no team_role at all. A staff guard here would
  // refuse a coach the database would have answered, and refuse a member their
  // own rows. Both screens ask the server instead and print the refusal.
  //
  // If somebody "tightens" these to RequireStaff later, this test is the note
  // explaining why that is a regression rather than a fix.
  it('keeps the record drill-down on RequireAuth, matching records_read', () => {
    expect(guardsFor(`/members/${MEMBER_ID}/records`)).toEqual([
      'auth',
      '/members/:memberId/records',
    ])
  })

  it('keeps the activity drill-down on RequireAuth, matching applications_read', () => {
    expect(guardsFor(`/members/${MEMBER_ID}/activities/training`)).toEqual([
      'auth',
      '/members/:memberId/activities/:kind',
    ])
  })

  // Deeper literal siblings of /members/:memberId. If the detail route ever
  // swallowed them, "상세 기록 ›" would reopen the page it was pressed on.
  it('does not let the member detail route swallow either drill-down', () => {
    expect(guardsFor(`/members/${MEMBER_ID}/records`)).not.toContain('/members/:memberId')
    expect(guardsFor(`/members/${MEMBER_ID}/activities/race`)).not.toContain('/members/:memberId')
  })
})

describe('chat routes are guarded by tree position', () => {
  it('keeps both chat screens on RequireAuth', () => {
    expect(guardsFor('/chat')).toEqual(['auth', '/chat'])
    expect(guardsFor(`/chat/dm/${MEMBER_ID}`)).toEqual(['auth', '/chat/dm/:memberId'])
  })

  // A dm is a member-to-member conversation, not an admin surface: messages_read
  // (0005) hands each row to its two participants and send_message_v1 derives
  // the sender from the session, so there is no staff-only chat route and no
  // test claiming there is.
  it('does not put chat behind a staff guard', () => {
    expect(guardsFor('/chat')).not.toContain('staff')
    expect(guardsFor(`/chat/dm/${MEMBER_ID}`)).not.toContain('staff')
  })

  // /members/:memberId is the other route shaped like "a member id in a path".
  // If it ever swallowed this one, tapping a conversation would open a profile.
  it('does not let the member detail route swallow a dm', () => {
    expect(guardsFor(`/chat/dm/${MEMBER_ID}`)).not.toContain('/members/:memberId')
  })
})

describe('notification settings is guarded by tree position', () => {
  // Each member manages their own devices, and push_subscriptions_self (0004)
  // is what confines them to their own rows — the guard only decides who sees
  // a screen, as everywhere else here.
  it('puts 알림 설정 on RequireAuth only', () => {
    expect(guardsFor('/settings/notifications')).toEqual(['auth', '/settings/notifications'])
  })
})

describe('media routes are guarded by tree position', () => {
  it('lets any approved member browse folders and their contents', () => {
    expect(guardsFor('/media')).toEqual(['auth', '/media'])
    expect(guardsFor(`/media/${FOLDER_ID}`)).toEqual(['auth', '/media/:folderId'])
  })

  // Uploading and creating folders are staff-only in the UI but not in RLS
  // (media_files_insert / media_folders_insert accept any approved member), so
  // there is no staff-only media route to guard — and no test claiming there is.
  it('keeps both media screens on RequireAuth only', () => {
    expect(guardsFor('/media')).not.toContain('staff')
    expect(guardsFor(`/media/${FOLDER_ID}`)).not.toContain('staff')
  })

  // 자료실 is the same table with a null folder_id, and media_files_read shows
  // it to every approved member, so it is guarded exactly like /media.
  it('puts 자료실 on RequireAuth', () => {
    expect(guardsFor('/files')).toEqual(['auth', '/files'])
  })

  // A sibling of /media, not a child: a literal /files cannot be mistaken for
  // a folder id, and the folder route must not answer for it.
  it('does not let the folder route swallow /files', () => {
    expect(guardsFor('/files')).not.toContain('/media/:folderId')
  })
})

describe('event ranking routes are guarded by tree position', () => {
  // The hub and the three ranking screens are readable by every approved
  // member, which is what the president's app does. team_event_rankings_v1()
  // refuses anyone else in the database, so RequireAuth keeps out nobody the
  // server would have answered anyway.
  it('puts the hub and a ranking on RequireAuth', () => {
    expect(guardsFor('/events')).toEqual(['auth', '/events'])
    expect(guardsFor('/events/attendance')).toEqual(['auth', '/events/:kind'])
    expect(guardsFor('/events/improve')).toEqual(['auth', '/events/:kind'])
  })

  it('does not put a ranking behind a staff guard', () => {
    expect(guardsFor('/events/late')).not.toContain('staff')
    expect(guardsFor('/events/late')).not.toContain('master')
  })
})

describe('my race history route is guarded by tree position', () => {
  // /schedule/mine is a literal sibling of the dynamic /schedule/:activityId,
  // so which one answers is decided by ranked matching rather than declaration
  // order — the same pairing that made /notices/new worth its own test. If the
  // dynamic route won, the screen would try to load an activity called "mine".
  it('sends /schedule/mine to the race history screen, not the detail route', () => {
    expect(guardsFor('/schedule/mine')).toEqual(['auth', '/schedule/mine'])
    expect(guardsFor('/schedule/mine')).not.toContain('/schedule/:activityId')
  })

  // race_my_history_v1() takes no member id and reads the caller from the
  // session, so there is no URL a member could type to reach another member's
  // history — RequireAuth is the whole gate this route needs.
  it('keeps it on RequireAuth only', () => {
    expect(guardsFor('/schedule/mine')).not.toContain('staff')
    expect(guardsFor('/schedule/mine')).not.toContain('master')
  })
})

describe('board routes are guarded by tree position', () => {
  // /board/new is a literal sibling of the dynamic /board/:postId, so which one
  // answers is decided by ranked matching rather than declaration order — the
  // same pairing that made /notices/new worth its own test. If the dynamic route
  // won, 글 작성 would open a detail screen for a post called "new".
  it('sends /board/new to the editor, not the detail route', () => {
    expect(guardsFor('/board/new')).toEqual(['auth', '/board/new'])
    expect(guardsFor('/board/new')).not.toContain('/board/:postId')
  })

  it('puts the list and one post on RequireAuth', () => {
    expect(guardsFor('/board')).toEqual(['auth', '/board'])
    expect(guardsFor(`/board/${POST_ID}`)).toEqual(['auth', '/board/:postId'])
  })

  it('puts the edit route on RequireAuth', () => {
    expect(guardsFor(`/board/${POST_ID}/edit`)).toEqual(['auth', '/board/:postId/edit'])
  })

  // The load-bearing one. Writing here is open to every approved member — the ＋
  // is unconditional markup in his app (upstream:1279) — so a staff guard on any
  // of these four would lock the board's own audience out of it. Editing is
  // narrower than staff, not wider: the author alone, which no position in the
  // tree can express, so update_board_post_v1 decides it and the screen mirrors
  // that. A RequireStaff here would be a guard that contradicts the database in
  // both directions at once.
  it('never sends a board route through a role guard', () => {
    for (const path of ['/board', '/board/new', `/board/${POST_ID}`, `/board/${POST_ID}/edit`]) {
      expect(guardsFor(path)).not.toContain('staff')
      expect(guardsFor(path)).not.toContain('master')
    }
  })

  it('does not fall through to the catch-all', () => {
    expect(guardsFor('/board')).not.toContain('*')
    expect(guardsFor(`/board/${POST_ID}`)).not.toContain('*')
  })
})
