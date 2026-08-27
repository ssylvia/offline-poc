/// <reference lib="webworker" />

import { clientsClaim } from 'workbox-core'
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { CacheFirst } from 'workbox-strategies'

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ revision?: string; url: string }>
}

const runtimeCacheName = `arcgis-sdk-runtime-${__ARCGIS_SDK_VERSION__}`
const packageCacheByClient = new Map<string, string>()
let lastActivePackageCache: string | undefined

self.skipWaiting()
clientsClaim()
cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')))

registerRoute(
  ({ url }) => url.origin === self.location.origin && url.pathname.includes('/arcgis-assets/'),
  new CacheFirst({ cacheName: runtimeCacheName }),
)

self.addEventListener('message', (event) => {
  if (!event.data || typeof event.data !== 'object') {
    return
  }

  const message = event.data as { cacheName?: string; type?: string }
  const sourceId = event.source && 'id' in event.source ? event.source.id : undefined

  if (message.type === 'ACTIVATE_PACKAGE_CACHE' && message.cacheName) {
    if (sourceId) {
      packageCacheByClient.set(sourceId, message.cacheName)
    }
    lastActivePackageCache = message.cacheName
    event.ports[0]?.postMessage({ activated: true })
  }

  if (message.type === 'DEACTIVATE_PACKAGE_CACHE') {
    if (sourceId) {
      packageCacheByClient.delete(sourceId)
    }
    if (!sourceId || packageCacheByClient.size === 0) {
      lastActivePackageCache = undefined
    }
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

  const packageCacheName = packageCacheByClient.get(event.clientId) ?? lastActivePackageCache
  if (!packageCacheName) {
    return
  }

  event.respondWith((async () => {
    const packageCache = await caches.open(packageCacheName)
    const cachedResponse = await packageCache.match(request)
    if (cachedResponse) {
      return cachedResponse
    }

    try {
      return await fetch(request)
    } catch (error) {
      throw new Error(`Resource is not available in the active offline package: ${request.url}`, {
        cause: error,
      })
    }
  })())
})
