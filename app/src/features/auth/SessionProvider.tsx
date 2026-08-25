import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase'
import { queryClient } from '../../lib/queryClient'

type SessionState = { session: Session | null; initializing: boolean }

const SessionContext = createContext<SessionState>({ session: null, initializing: true })

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ session: null, initializing: true })

  useEffect(() => {
    let active = true

    void supabase.auth.getSession().then(({ data }) => {
      if (active) setState({ session: data.session, initializing: false })
    })

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setState({ session, initializing: false })
      // The member record is server state keyed to the session; drop it so the
      // next render refetches rather than showing the previous user's role.
      void queryClient.invalidateQueries({ queryKey: ['me'] })
    })

    return () => {
      active = false
      sub.subscription.unsubscribe()
    }
  }, [])

  return <SessionContext.Provider value={state}>{children}</SessionContext.Provider>
}

export const useSession = () => useContext(SessionContext)
