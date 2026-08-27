import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App.tsx'

registerSW({
  immediate: true,
  onRegisterError(error) {
    console.error('The offline service worker could not be registered.', error)
  },
})

const root = document.getElementById('root')
if (!root) {
  throw new Error('The application root element is missing.')
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
