import MapView from '@arcgis/core/views/MapView.js'
import WebMap from '@arcgis/core/WebMap.js'
import { useEffect, useRef, useState } from 'react'
import { getErrorMessage } from '../../../shared/format.ts'
import type { LiveMapSession } from '../types.ts'
import { loadPublicWebMapItem } from './portal.ts'

interface LiveMapProps {
  onError: (message: string) => void
  onReady: (session: LiveMapSession) => void
  webmapId: string
}

export function LiveMap({ onError, onReady, webmapId }: LiveMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    let view: MapView | undefined
    let disposed = false

    const load = async () => {
      setIsLoading(true)
      const { item, itemData } = await loadPublicWebMapItem(webmapId, controller.signal)
      if (disposed || !containerRef.current) {
        return
      }

      const map = new WebMap({ portalItem: { id: webmapId } })
      view = new MapView({
        container: containerRef.current,
        map,
        popup: {
          dockEnabled: true,
          dockOptions: {
            buttonEnabled: false,
            position: 'bottom-right',
          },
        },
      })
      await view.when()
      if (disposed) {
        return
      }

      setIsLoading(false)
      onReady({ item, itemData, map, view })
    }

    void load().catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setIsLoading(false)
        onError(getErrorMessage(error))
      }
    })

    return () => {
      disposed = true
      controller.abort()
      view?.destroy()
    }
  }, [onError, onReady, webmapId])

  return (
    <div className="map-host">
      <div className="map-container" ref={containerRef} />
      {isLoading && (
        <div className="map-loading" role="status">
          <span className="spinner" aria-hidden="true" />
          Loading public WebMap…
        </div>
      )}
    </div>
  )
}
