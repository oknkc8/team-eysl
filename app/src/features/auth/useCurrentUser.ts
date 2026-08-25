import { useQuery } from '@tanstack/react-query'
import { useSession } from './SessionProvider'
import { getMyMember } from './api'

export function useCurrentUser() {
  const { session, initializing } = useSession()

  const query = useQuery({
    queryKey: ['me', session?.user.id],
    // The id is passed rather than looked up inside getMyMember, so the value the
    // query filters on is the same one it is cached under. `enabled` is what makes
    // the assertion safe: the function does not run without a session.
    queryFn: () => getMyMember(session!.user.id),
    enabled: !!session,
    staleTime: 5 * 60_000,
  })

  return {
    user: query.data ?? null,
    isLoading: initializing || (!!session && query.isLoading),
    session,
  }
}
