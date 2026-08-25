import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router'
import { Providers } from './app/providers'
import { router } from './app/router'

const el = document.getElementById('root')
if (!el) throw new Error('#root not found')

createRoot(el).render(
  <StrictMode>
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  </StrictMode>,
)
