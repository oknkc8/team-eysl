import { describe, it, expect, afterEach, vi } from 'vitest'

// env.ts validates at module load, so each case needs a fresh module registry.
async function loadEnv(vars: Record<string, string>) {
  vi.resetModules()
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v)
  return import('./env')
}

const OURS = {
  VITE_SUPABASE_URL: 'https://ourdevproject.supabase.co',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
}

describe('env', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('accepts our own project', async () => {
    const { env } = await loadEnv(OURS)
    expect(env.SUPABASE_URL).toBe(OURS.VITE_SUPABASE_URL)
  })

  it('refuses the production project even when the URL is otherwise valid', async () => {
    // The CI guard only inspects committed files; this is the backstop for a
    // deployment variable pointed at the club president's live database.
    await expect(
      loadEnv({
        ...OURS,
        VITE_SUPABASE_URL: 'https://rbghqyhzvczavtjwiocc.supabase.co',
      }),
    ).rejects.toThrow(/production project/i)
  })

  it('refuses a missing key rather than starting half-configured', async () => {
    await expect(
      loadEnv({ VITE_SUPABASE_URL: OURS.VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY: '' }),
    ).rejects.toThrow()
  })
})
