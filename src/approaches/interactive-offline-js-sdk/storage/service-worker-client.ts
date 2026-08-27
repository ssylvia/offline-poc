export async function activatePackageCache(cacheName: string): Promise<void> {
  const registration = await navigator.serviceWorker.ready
  const worker = navigator.serviceWorker.controller ?? registration.active
  if (!worker) {
    throw new Error('The offline service worker is not active yet. Reload and try again.')
  }

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
    worker.postMessage(
      { type: 'ACTIVATE_PACKAGE_CACHE', cacheName },
      [channel.port2],
    )
  })
}

export function deactivatePackageCache(): void {
  navigator.serviceWorker.controller?.postMessage({ type: 'DEACTIVATE_PACKAGE_CACHE' })
}
