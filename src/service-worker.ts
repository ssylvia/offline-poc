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
  resourceByUrl: Map<string, StoredResource>
}

const packageSourceByClient = new Map<string, ActivePackageSource>()
let lastActivePackageSource: ActivePackageSource | undefined

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

  const message = event.data as { source?: PackageSourceMessage; type?: string }
  const sourceId = event.source && 'id' in event.source ? event.source.id : undefined

  if (message.type === 'ACTIVATE_PACKAGE_CACHE' && message.source) {
    const activeSource: ActivePackageSource = {
      ...message.source,
      resourceByUrl: new Map(message.source.resources.map((resource) => (
        [canonicalizeUrl(resource.url), resource]
      ))),
    }
    if (sourceId) {
      packageSourceByClient.set(sourceId, activeSource)
    }
    lastActivePackageSource = activeSource
    event.ports[0]?.postMessage({ activated: true })
  }

  if (message.type === 'DEACTIVATE_PACKAGE_CACHE') {
    if (sourceId) {
      packageSourceByClient.delete(sourceId)
    }
    if (!sourceId || packageSourceByClient.size === 0) {
      lastActivePackageSource = undefined
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

  const packageSource = packageSourceByClient.get(event.clientId) ?? lastActivePackageSource
  if (!packageSource) {
    return
  }

  event.respondWith((async () => {
    const canonicalUrl = canonicalizeUrl(request.url)
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

function canonicalizeUrl(value: string): string {
  const url = new URL(value)
  url.hash = ''
  const entries = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) => (
    leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
  ))
  url.search = ''
  for (const [key, value] of entries) {
    url.searchParams.append(key, value)
  }
  return url.href
}

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
