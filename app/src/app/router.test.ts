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
