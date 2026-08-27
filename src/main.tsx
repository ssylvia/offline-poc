import './index.css'

const serviceWorkerControlTimeoutMs = 15_000

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

void waitForServiceWorkerControl()
  .catch((error: unknown) => {
    console.error('The application is continuing without confirmed offline control.', error)
  })
  .then(() => import('./bootstrap.tsx'))
  .catch((error: unknown) => {
    console.error('The application could not be started.', error)
  })
