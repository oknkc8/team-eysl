import { useQuery } from '@tanstack/react-query'
import { useSession } from './SessionProvider'
import { getMyMember } from './api'

export function useCurrentUser() {
  const { session, initializing } = useSession()

  const query = useQuery({
    queryKey: ['me', session?.user.id],
    queryFn: getMyMember,
    enabled: !!session,
    staleTime: 5 * 60_000,
  })

  return {
    user: query.data ?? null,
    isLoading: initializing || (!!session && query.isLoading),
    session,
  }
}
