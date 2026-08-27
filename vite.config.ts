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
const basePath = `/${(process.env.VITE_BASE_PATH ?? '').replace(/^\/+|\/+$/g, '')}${process.env.VITE_BASE_PATH ? '/' : ''}`

function withBasePath(path = ''): string {
  return `${basePath}${path.replace(/^\/+/, '')}`
}

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

function arcgisRuntimeManifest(): Plugin {
  let source = ''

  const createSource = () => {
    return JSON.stringify({
      sdkVersion: arcgisPackage.version,
      basePath: withBasePath('arcgis-assets/'),
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
  base: basePath,
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
      injectRegister: null,
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
        scope: basePath,
        start_url: basePath,
        shortcuts: [
          {
            name: 'Interactive snapshot',
            short_name: 'Snapshot',
            description: 'Open the bounded interactive offline snapshot workflow.',
            url: basePath,
          },
          {
            name: 'Offline video package',
            short_name: 'Video',
            description: 'Open the popup-aware offline video package workflow.',
            url: `${basePath}?approach=offline-video`,
          },
        ],
        icons: [
          {
            src: withBasePath('favicon.svg'),
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      injectManifest: {
        globPatterns: [
          'index.html',
          'manifest.webmanifest',
          'favicon.svg',
          'icons.svg',
          'assets/index-*.js',
          'assets/index-*.css',
        ],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
      devOptions: {
        enabled: true,
        type: 'module',
      },
    }),
  ],
})
