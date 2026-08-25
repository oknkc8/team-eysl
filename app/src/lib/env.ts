import { z } from 'zod'

// Parsed at module load so a missing variable fails loudly here, rather than
// surfacing later as an inexplicable 404 against `undefined/rest/v1`.
const schema = z.object({
  VITE_SUPABASE_URL: z.string().url(),
  VITE_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
})

const parsed = schema.safeParse(import.meta.env)

if (!parsed.success) {
  throw new Error(
    `Missing or invalid environment variables: ${parsed.error.issues
      .map((i) => i.path.join('.'))
      .join(', ')}. Copy .env.example to .env and fill it in.`,
  )
}

// The club president's live project, holding real member data we have no
// authority over. The CI guard only inspects committed files, so a mistyped
// deployment variable would sail past it and let this build write to production.
// Refuse at startup instead: a blank screen is recoverable, corrupted attendance
// records are not.
const FORBIDDEN_PROJECT_REF = 'rbghqyhzvczavtjwiocc'

// Compared lowercased: hostnames are case-insensitive, so an uppercased ref
// resolves to exactly the same database while sailing past a literal match.
if (parsed.data.VITE_SUPABASE_URL.toLowerCase().includes(FORBIDDEN_PROJECT_REF)) {
  throw new Error(
    'VITE_SUPABASE_URL points at the production project. This build must never ' +
      'connect to it — point it at our own project instead.',
  )
}

export const env = {
  SUPABASE_URL: parsed.data.VITE_SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY: parsed.data.VITE_SUPABASE_PUBLISHABLE_KEY,
}
