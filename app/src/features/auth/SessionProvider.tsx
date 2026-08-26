import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase'
import { queryClient } from '../../lib/queryClient'

type SessionState = { session: Session | null; initializing: boolean }

/**
 * Whether an auth event means the cache now belongs to somebody else.
 *
 * `undefined` is "no event seen yet" and is deliberately not the same as `null`
 * ("signed out"): supabase-js fires INITIAL_SESSION on startup, and treating
 * that first event as a change would throw away a cache that was only just
 * filled.
 *
 * A token refresh keeps the same user id and is therefore not a change — that
 * distinction is the whole reason this compares ids rather than event names.
 */
export function isIdentityChange(
  previous: string | null | undefined,
  next: string | null,
): boolean {
  return previous !== undefined && previous !== next
}

const SessionContext = createContext<SessionState>({ session: null, initializing: true })

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ session: null, initializing: true })

  // Survives re-renders without causing them: nothing renders off this value,
  // it only decides what to do with the cache on the next auth event.
  const previousUserId = useRef<string | null | undefined>(undefined)

  useEffect(() => {
    let active = true

    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return
      // Establishes the baseline if onAuthStateChange has not fired yet, so the
      // first real transition is measured against a known id rather than
      // against `undefined`.
      if (previousUserId.current === undefined) {
        previousUserId.current = data.session?.user.id ?? null
      }
      setState({ session: data.session, initializing: false })
    })

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      const nextUserId = session?.user.id ?? null
      const changed = isIdentityChange(previousUserId.current, nextUserId)
      previousUserId.current = nextUserId

      setState({ session, initializing: false })

      if (changed) {
        // EVERYTHING cached was fetched as the previous identity, so all of it
        // now belongs to somebody else. Invalidating `['me']` alone was the old
        // behaviour and it left the rest behind: on a shared phone or the club's
        // front desk, B signs in and reads A's 마이페이지 out of cache for the
        // whole 30s staleTime without issuing a request. The server was never
        // wrong — my_achievement_v1 and its neighbours take no member id and
        // resolve the caller through current_member_id() — so no amount of RLS
        // review would have found it. Keying each personal query by member fixes
        // the ones we know about; clearing here covers the ones nobody thought
        // about, including every query added later.
        //
        // clear, not invalidate: invalidate refetches anything still mounted,
        // and at sign-out the token is already revoked, so that refetch is a
        // guaranteed 401.
        queryClient.clear()
      } else {
        // Same person, new token. The member record is server state keyed to the
        // session, so it is refetched rather than trusted.
        void queryClient.invalidateQueries({ queryKey: ['me'] })
      }
    })

    return () => {
      active = false
      sub.subscription.unsubscribe()
    }
  }, [])

  return <SessionContext.Provider value={state}>{children}</SessionContext.Provider>
}

export const useSession = () => useContext(SessionContext)
