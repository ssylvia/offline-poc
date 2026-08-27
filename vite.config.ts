import react from '@vitejs/plugin-react'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { viteStaticCopy } from 'vite-plugin-static-copy'

const arcgisPackage = JSON.parse(
  readFileSync(resolve('node_modules/@arcgis/core/package.json'), 'utf8'),
) as { version: string }
const arcgisAssetsRoot = resolve('node_modules/@arcgis/core/assets')

function collectAssetFiles(root: string, directory = root): Array<{ path: string; size: number }> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = join(directory, entry.name)
    if (entry.isDirectory()) {
      return collectAssetFiles(root, absolutePath)
    }

    return [{
      path: relative(root, absolutePath).split('\\').join('/'),
      size: lstatSync(absolutePath).size,
    }]
  })
}

const arcgisAssetFiles = collectAssetFiles(arcgisAssetsRoot)
const defaultLocalePattern = /\/t9n\/.+(?<!_[a-z]{2}(?:-[a-z]{2})?)\.json$/i
const offlineWidgetIconNames = new Set([
  'chevronDown16.json',
  'chevronLeft16.json',
  'chevronRight16.json',
  'contract16.json',
  'dockBottom16.json',
  'dockLeft16.json',
  'dockRight16.json',
  'ellipsis16.json',
  'expand16.json',
  'magnifyingGlassPlus16.json',
  'minus16.json',
  'plus16.json',
  'x16.json',
])
const offlineArcGisAssets = arcgisAssetFiles
  .filter((file) => (
    file.path.endsWith('_en.json')
    || defaultLocalePattern.test(`/${file.path}`)
    || (
      file.path.startsWith('components/assets/icon/')
      && offlineWidgetIconNames.has(file.path.split('/').at(-1) ?? '')
    )
    || file.path.startsWith('esri/core/workers/')
    || file.path.startsWith('esri/geometry/')
  ))
  .map((file) => ({
    revision: `${arcgisPackage.version}-${file.size}`,
    url: `/arcgis-assets/${file.path}`,
  }))

function arcgisRuntimeManifest(): Plugin {
  let source = ''

  const createSource = () => {
    return JSON.stringify({
      sdkVersion: arcgisPackage.version,
      basePath: '/arcgis-assets/',
      fileCount: arcgisAssetFiles.length,
      totalBytes: arcgisAssetFiles.reduce((total, file) => total + file.size, 0),
      files: arcgisAssetFiles,
    })
  }

  return {
    name: 'arcgis-runtime-manifest',
    buildStart() {
      source = createSource()
    },
    configureServer(server) {
      server.middlewares.use('/arcgis-runtime-manifest.json', (_request, response) => {
        source ||= createSource()
        response.setHeader('Content-Type', 'application/json')
        response.end(source)
      })
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'arcgis-runtime-manifest.json',
        source,
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  define: {
    __ARCGIS_SDK_VERSION__: JSON.stringify(arcgisPackage.version),
  },
  plugins: [
    react(),
    arcgisRuntimeManifest(),
    viteStaticCopy({
      targets: [{
        src: 'node_modules/@arcgis/core/assets/**/*',
        dest: 'arcgis-assets',
        rename: { stripBase: 4 },
      }],
    }),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'service-worker.ts',
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Offline ArcGIS WebMap Viewer',
        short_name: 'Offline WebMaps',
        description: 'Prototype for bounded ArcGIS WebMap snapshots and browser-local offline video packages.',
        theme_color: '#16324f',
        background_color: '#f4f7fa',
        display: 'standalone',
        scope: '/',
        start_url: '/',
        shortcuts: [
          {
            name: 'Interactive snapshot',
            short_name: 'Snapshot',
            description: 'Open the bounded interactive offline snapshot workflow.',
            url: '/',
          },
          {
            name: 'Offline video package',
            short_name: 'Video',
            description: 'Open the popup-aware offline video package workflow.',
            url: '/?approach=offline-video',
          },
        ],
        icons: [
          {
            src: '/favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      injectManifest: {
        additionalManifestEntries: offlineArcGisAssets,
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest,json,woff,woff2,ttf,wasm}'],
        globIgnores: ['arcgis-assets/**/*'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
      devOptions: {
        enabled: true,
        type: 'module',
      },
    }),
  ],
})
