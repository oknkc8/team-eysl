import { supabase } from '../../lib/supabase'
import { memberSchema, type CurrentUser } from './schema'

export async function getMyMember(): Promise<CurrentUser | null> {
  const { data, error } = await supabase
    .from('members')
    .select('id, nickname, real_name, avatar_path, role, status')
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  // Parsed rather than cast: the generated types describe the schema as it was
  // when generated, not as the server answers today.
  return memberSchema.parse(data)
}
