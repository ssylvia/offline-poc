/// <reference lib="webworker" />

import { clientsClaim } from 'workbox-core'
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { CacheFirst } from 'workbox-strategies'
import { canonicalizeOfflineResourceUrl } from './shared/arcgis/offline-resource-url.ts'

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ revision?: string; url: string }>
}

const runtimeCachePrefix = 'arcgis-sdk-runtime-'
const runtimeCacheName = import.meta.env.DEV
  ? `${runtimeCachePrefix}development`
  : `${runtimeCachePrefix}${__ARCGIS_SDK_VERSION__}`
const appRuntimeCacheName = 'offline-app-runtime-v1'
const appBuildId = import.meta.env.DEV ? 'development' : __APP_BUILD_ID__
const appShellUrl = `${import.meta.env.BASE_URL}index.html`

interface StoredResource {
  contentType: string
  path?: string
  size: number
  url: string
}

type PackageSourceMessage =
  | {
      cacheName: string
      kind: 'cache'
      resources: StoredResource[]
    }
  | {
      directory: FileSystemDirectoryHandle
      kind: 'directory'
      resources: StoredResource[]
    }

type ActivePackageSource = (
  | {
      cacheName: string
      kind: 'cache'
    }
  | {
      directory: FileSystemDirectoryHandle
      kind: 'directory'
    }
) & {
  activationId: string
  activationSequence: number
  resourceByUrl: Map<string, StoredResource>
}

const packageSourceByClient = new Map<string, ActivePackageSource>()
let lastActivePackageSource: ActivePackageSource | undefined

self.skipWaiting()
clientsClaim()
cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)
if (import.meta.env.PROD) {
  registerRoute(new NavigationRoute(createHandlerBoundToURL(appShellUrl)))
}

registerRoute(
  ({ url }) => url.origin === self.location.origin && url.pathname.includes('/arcgis-assets/'),
  new CacheFirst({ cacheName: runtimeCacheName }),
)
registerRoute(
  ({ request, url }) => (
    url.origin === self.location.origin
    && url.pathname.includes('/assets/')
    && ['font', 'image', 'script', 'style', 'worker'].includes(request.destination)
  ),
  new CacheFirst({ cacheName: appRuntimeCacheName }),
)

self.addEventListener('message', (event) => {
  if (!event.data || typeof event.data !== 'object') {
    return
  }

  const message = event.data as {
    activationId?: string
    activationSequence?: number
    buildId?: string
    retainedUrls?: string[]
    source?: PackageSourceMessage
    type?: string
  }
  const sourceId = event.source && 'id' in event.source ? event.source.id : undefined

  if (message.type === 'ACTIVATE_PACKAGE_CACHE' && message.source) {
    const activationId = message.activationId ?? `legacy:${sourceId ?? 'unknown'}`
    const activationSequence = message.activationSequence ?? 0
    const activeSource: ActivePackageSource = {
      activationId,
      activationSequence,
      ...message.source,
      resourceByUrl: new Map(message.source.resources.map((resource) => (
        [canonicalizeOfflineResourceUrl(resource.url), resource]
      ))),
    }
    const currentSource = sourceId
      ? packageSourceByClient.get(sourceId)
      : lastActivePackageSource
    const isStale = currentSource !== undefined
      && currentSource.activationSequence > activationSequence
    if (!isStale && sourceId) {
      packageSourceByClient.set(sourceId, activeSource)
    }
    if (!isStale) {
      lastActivePackageSource = activeSource
    }
    event.ports[0]?.postMessage({ activated: !isStale })
  }

  if (message.type === 'DEACTIVATE_PACKAGE_CACHE') {
    const clientSource = sourceId ? packageSourceByClient.get(sourceId) : undefined
    const releaseClientSource = !message.activationId
      || clientSource?.activationId === message.activationId
    if (sourceId && releaseClientSource) {
      packageSourceByClient.delete(sourceId)
    }
    const releaseLastSource = !message.activationId
      || lastActivePackageSource?.activationId === message.activationId
    if (releaseLastSource) {
      lastActivePackageSource = [...packageSourceByClient.values()].at(-1)
    }
  }

  if (
    message.type === 'PRUNE_RUNTIME_CACHES'
    && message.buildId === appBuildId
    && Array.isArray(message.retainedUrls)
  ) {
    event.waitUntil((async () => {
      const windowClients = await self.clients.matchAll({
        includeUncontrolled: true,
        type: 'window',
      })
      if (windowClients.length !== 1) {
        return
      }

      const retainedUrls = new Set(message.retainedUrls)
      const appCache = await caches.open(appRuntimeCacheName)
      for (const request of await appCache.keys()) {
        if (!retainedUrls.has(request.url)) {
          await appCache.delete(request)
        }
      }
      for (const cacheName of await caches.keys()) {
        if (cacheName.startsWith(runtimeCachePrefix) && cacheName !== runtimeCacheName) {
          await caches.delete(cacheName)
        }
      }
    })())
  }
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') {
    return
  }

  const url = new URL(request.url)
  if (url.origin === self.location.origin) {
    return
  }

  const packageSource = packageSourceByClient.get(event.clientId) ?? lastActivePackageSource
  if (!packageSource) {
    return
  }

  event.respondWith((async () => {
    const canonicalUrl = canonicalizeOfflineResourceUrl(request.url)
    const resource = packageSource.resourceByUrl.get(canonicalUrl)
    if (packageSource.kind === 'directory' && resource?.path) {
      const file = await readDirectoryFile(packageSource.directory, resource.path)
      return new Response(file, {
        headers: {
          'Content-Length': String(file.size),
          'Content-Type': resource.contentType,
        },
      })
    }
    if (packageSource.kind === 'cache') {
      const packageCache = await caches.open(packageSource.cacheName)
      const cachedResponse = await packageCache.match(resource?.url ?? request)
      if (cachedResponse) {
        return cachedResponse
      }
    }

    if (!self.navigator.onLine) {
      return new Response(`Resource is not available in the active offline package: ${request.url}`, {
        status: 504,
        statusText: 'Offline resource unavailable',
      })
    }
    try {
      return await fetch(request)
    } catch {
      return new Response(`Resource is not available in the active offline package: ${request.url}`, {
        status: 504,
        statusText: 'Offline resource unavailable',
      })
    }
  })())
})

async function readDirectoryFile(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<File> {
  const parts = path.split('/').filter(Boolean)
  const fileName = parts.pop()
  if (!fileName || parts.some((part) => part === '.' || part === '..')) {
    throw new Error(`Invalid package resource path: ${path}`)
  }
  let directory = root
  for (const part of parts) {
    directory = await directory.getDirectoryHandle(part)
  }
  return (await directory.getFileHandle(fileName)).getFile()
}
