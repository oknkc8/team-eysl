import { z } from 'zod'

// Parsed at module load so a missing variable fails loudly here, rather than
// surfacing later as an inexplicable 404 against `undefined/rest/v1`.
const schema = z.object({
  VITE_SUPABASE_URL: z.string().url(),
  VITE_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  // Optional, unlike the two above, and deliberately so: without it the app
  // still runs and every other screen works — only 알림 설정 has to say it is
  // not configured. Making it required would turn "push is not set up yet" into
  // a blank page for the whole club.
  //
  // Public by design. A VAPID key pair is public half in the browser, private
  // half wherever notifications are sent from; the private half has no business
  // in a VITE_ variable, which ships to every visitor, and none in this
  // repository, which is public.
  VITE_VAPID_PUBLIC_KEY: z.string().optional(),
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
  // null rather than '' so "not configured" is a state the settings screen can
  // test for, instead of a key that fails later inside pushManager.subscribe().
  VAPID_PUBLIC_KEY: parsed.data.VITE_VAPID_PUBLIC_KEY?.trim() || null,
}
