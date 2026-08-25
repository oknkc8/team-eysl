import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router'
import { Providers } from './app/providers'
import { router } from './app/router'

// Order matters and is the whole contract: tokens declare the custom properties,
// base consumes them for the reset and the phone frame, components for the
// shapes. Nothing imported these until now, which is why every screen rendered
// in the browser's default serif with no card, no ground colour and no frame.
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'

const el = document.getElementById('root')
if (!el) throw new Error('#root not found')

createRoot(el).render(
  <StrictMode>
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  </StrictMode>,
)
