import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { matchRoutes, type RouteObject } from 'react-router'

// Importing the router reaches the Supabase client, which validates env at
// module load — so the values are stubbed before the dynamic import, the same
// way env.test.ts does it.
let router: (typeof import('./router'))['router']
let RequireAuth: (typeof import('./guards'))['RequireAuth']
let RequireStaff: (typeof import('./guards'))['RequireStaff']

beforeAll(async () => {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://ourdevproject.supabase.co')
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test')
  ;({ router } = await import('./router'))
  ;({ RequireAuth, RequireStaff } = await import('./guards'))
})

afterAll(() => vi.unstubAllEnvs())

const NOTICE_ID = '00000000-0000-4000-8000-000000000001'
const ACTIVITY_ID = '00000000-0000-4000-8000-000000000002'

function guardsFor(pathname: string) {
  const matches = matchRoutes(router.routes as RouteObject[], pathname) ?? []
  return matches.map((m) => {
    const element = m.route.element as { type?: unknown } | undefined
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
