import { getPackageDirectory } from '../../../shared/storage/directory.ts'
import type { SavedMapPackage } from '../types.ts'

const serviceWorkerReadyTimeoutMs = 15_000
let nextActivationSequence = 0

async function getReadyRegistration(): Promise<ServiceWorkerRegistration> {
  let timeout: number | undefined
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_resolve, reject) => {
        timeout = window.setTimeout(() => {
          reject(new Error(
            'The offline service worker could not finish installing. Reload while online and try again.',
          ))
        }, serviceWorkerReadyTimeoutMs)
      }),
    ])
  } finally {
    if (timeout !== undefined) {
      window.clearTimeout(timeout)
    }
  }
}

export async function activatePackageCache(
  packageRecord: SavedMapPackage,
): Promise<string> {
  const registration = await getReadyRegistration()
  const worker = navigator.serviceWorker.controller ?? registration.active
  if (!worker) {
    throw new Error('The offline service worker is not active yet. Reload and try again.')
  }
  const activationId = crypto.randomUUID()
  const activationSequence = Date.now() * 1_000 + (++nextActivationSequence % 1_000)

  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel()
    const timeout = window.setTimeout(() => {
      channel.port1.close()
      reject(new Error('The service worker did not activate the offline package in time.'))
    }, 5_000)

    channel.port1.onmessage = () => {
      window.clearTimeout(timeout)
      channel.port1.close()
      resolve()
    }
    void (async () => {
      const source = packageRecord.payloadStorage?.kind === 'directory'
        ? {
            directory: await getPackageDirectory(packageRecord.payloadStorage),
            kind: 'directory' as const,
            resources: packageRecord.resources ?? [],
          }
        : {
            cacheName: packageRecord.cacheName,
            kind: 'cache' as const,
            resources: packageRecord.resources ?? [],
          }
      worker.postMessage(
        {
          activationId,
          activationSequence,
          type: 'ACTIVATE_PACKAGE_CACHE',
          source,
        },
        [channel.port2],
      )
    })().catch((error: unknown) => {
      window.clearTimeout(timeout)
      channel.port1.close()
      reject(error)
    })
  })
  return activationId
}

export function deactivatePackageCache(activationId: string): void {
  navigator.serviceWorker.controller?.postMessage({
    activationId,
    type: 'DEACTIVATE_PACKAGE_CACHE',
  })
}
