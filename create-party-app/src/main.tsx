import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { app } from './app'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={app.queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
