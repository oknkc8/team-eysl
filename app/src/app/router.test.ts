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

function guardsFor(pathname: string) {
  const matches = matchRoutes(router.routes as RouteObject[], pathname) ?? []
  return matches.map((m) => {
    const element = m.route.element as { type?: unknown } | undefined
    if (element?.type === RequireMasterAdmin) return 'master'
    if (element?.type === RequireStaff) return 'staff'
    if (element?.type === RequireAuth) return 'auth'
    return m.route.path ?? 'screen'
  })
}

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

  // The editor lives under /admin so it shares no path segment shape with the
  // member detail route: there is no pair for ranked matching to choose between,
  // which is what made /notices/new worth a test of its own.
  it('puts creating an activity behind RequireStaff', () => {
    expect(guardsFor('/admin/schedule/new')).toEqual(['auth', 'staff', '/admin/schedule/new'])
  })

  it('puts editing an activity behind RequireStaff', () => {
    expect(guardsFor(`/admin/schedule/${ACTIVITY_ID}/edit`)).toEqual([
      'auth',
      'staff',
      '/admin/schedule/:activityId/edit',
    ])
  })

  // A member typing the staff URL must not be handed the member detail screen
  // by a stray match — it has to land on the guard and be redirected.
  it('does not let the member detail route swallow an admin path', () => {
    expect(guardsFor(`/admin/schedule/${ACTIVITY_ID}/edit`)).not.toContain('/schedule/:activityId')
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

  it('does not let the member records route swallow the admin path', () => {
    expect(guardsFor('/admin/records/new')).not.toContain('/records')
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
