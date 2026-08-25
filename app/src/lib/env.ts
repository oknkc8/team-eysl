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

export const env = {
  SUPABASE_URL: parsed.data.VITE_SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY: parsed.data.VITE_SUPABASE_PUBLISHABLE_KEY,
}
