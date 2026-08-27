import { useEffect, useState } from 'react'

export function useConnectivity(): boolean {
  const [isOnline, setIsOnline] = useState(() => navigator.onLine)

  useEffect(() => {
    let activeController: AbortController | undefined
    let disposed = false

    const probe = async () => {
      activeController?.abort()
      if (!navigator.onLine) {
        setIsOnline(false)
        return
      }

      const controller = new AbortController()
      activeController = controller
      const timeout = window.setTimeout(() => controller.abort(), 5_000)
      try {
        const response = await fetch(
          `https://www.arcgis.com/sharing/rest/info?f=json&probe=${Date.now()}`,
          {
            cache: 'no-store',
            credentials: 'omit',
            signal: controller.signal,
          },
        )
        if (!disposed) {
          setIsOnline(response.ok)
        }
      } catch {
        if (!disposed) {
          setIsOnline(false)
        }
      } finally {
        window.clearTimeout(timeout)
      }
    }

    const handleOnline = () => void probe()
    const handleOffline = () => setIsOnline(false)
    const interval = window.setInterval(() => void probe(), 30_000)

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    void probe()

    return () => {
      disposed = true
      activeController?.abort()
      window.clearInterval(interval)
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  return isOnline
}
