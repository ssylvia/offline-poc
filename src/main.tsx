import esriConfig from '@arcgis/core/config.js'
import '@arcgis/core/assets/esri/themes/light/main.css'
import './index.css'

esriConfig.assetsPath = `${window.location.origin}${import.meta.env.BASE_URL}arcgis-assets`

void import('./bootstrap.tsx')
