import esriConfig from '@arcgis/core/config.js'
import '@arcgis/core/assets/esri/themes/light/main.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'

esriConfig.assetsPath = `${window.location.origin}${import.meta.env.BASE_URL}arcgis-assets`

const root = document.getElementById('root')
if (!root) {
  throw new Error('The application root element is missing.')
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
