import './index.css'

const serviceWorkerControlTimeoutMs = 15_000
const appBuildId = import.meta.env.DEV ? 'development' : __APP_BUILD_ID__

const registrationPromise = 'serviceWorker' in navigator
  ? navigator.serviceWorker.register(
      import.meta.env.DEV
        ? `${import.meta.env.BASE_URL}dev-sw.js?dev-sw`
        : `${import.meta.env.BASE_URL}service-worker.js`,
      {
        scope: import.meta.env.BASE_URL,
        type: import.meta.env.DEV ? 'module' : 'classic',
      },
    )
  : Promise.resolve(undefined)

async function waitForServiceWorkerControl(): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    return
  }
  let timeout: number | undefined
  try {
    await Promise.race([
      (async () => {
        await registrationPromise
        await navigator.serviceWorker.ready
        if (navigator.serviceWorker.controller) {
          return
        }
        await new Promise<void>((resolve) => {
          navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
            once: true,
          })
        })
      })(),
      new Promise<void>((_resolve, reject) => {
        timeout = window.setTimeout(() => {
          reject(new Error('The offline service worker did not become ready in time.'))
        }, serviceWorkerControlTimeoutMs)
      }),
    ])
  } finally {
    if (timeout !== undefined) {
      window.clearTimeout(timeout)
    }
  }
}

interface OfflineAppRuntimeManifest {
  buildId: string
  files: string[]
}

async function pruneRuntimeCaches(): Promise<void> {
  const controller = navigator.serviceWorker?.controller
  if (!controller) {
    return
  }
  const manifestUrl = `${import.meta.env.BASE_URL}offline-app-runtime-manifest.json`
  const response = await fetch(manifestUrl)
  if (!response.ok) {
    throw new Error(
      `The offline application manifest could not be read: HTTP ${response.status}.`,
    )
  }
  const manifest = await response.json() as OfflineAppRuntimeManifest
  if (
    manifest.buildId !== appBuildId
    || !Array.isArray(manifest.files)
    || !manifest.files.every(
    (fileName) => typeof fileName === 'string' && fileName.startsWith('assets/'),
    )
  ) {
    throw new Error('The offline application manifest is invalid.')
  }
  const retainedUrls = manifest.files.map((fileName) => (
    new URL(`${import.meta.env.BASE_URL}${fileName}`, window.location.origin).href
  ))
  controller.postMessage({
    buildId: appBuildId,
    retainedUrls,
    type: 'PRUNE_RUNTIME_CACHES',
  })
}

void waitForServiceWorkerControl()
  .catch((error: unknown) => {
    console.error('The application is continuing without confirmed offline control.', error)
  })
  .then(() => import('./bootstrap.tsx'))
  .then(() => {
    void pruneRuntimeCaches().catch((error: unknown) => {
      console.error('Old offline application assets could not be pruned.', error)
    })
  })
  .catch((error: unknown) => {
    console.error('The application could not be started.', error)
  })
