import Expand from '@arcgis/core/widgets/Expand.js'
import LayerList from '@arcgis/core/widgets/LayerList.js'
import MapView from '@arcgis/core/views/MapView.js'
import WebMap from '@arcgis/core/WebMap.js'
import { useEffect, useRef, useState } from 'react'
import { getErrorMessage } from '../../../shared/format.ts'
import {
  loadPublicWebMapItem,
  type LiveMapSession,
} from '../../../shared/arcgis/index.ts'

interface VideoCaptureMapProps {
  isInteractionDisabled: boolean
  onError: (message: string) => void
  onReady: (session: LiveMapSession) => void
  webmapId: string
}

export function VideoCaptureMap({
  isInteractionDisabled,
  onError,
  onReady,
  webmapId,
}: VideoCaptureMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    let view: MapView | undefined
    let layerList: LayerList | undefined
    let layerListExpand: Expand | undefined
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
          dockEnabled: false,
        },
      })
      await view.when()
      await map.loadAll()
      if (disposed) {
        return
      }

      layerList = new LayerList({ view })
      layerListExpand = new Expand({
        content: layerList,
        expanded: false,
        group: 'top-right',
        view,
      })
      view.ui.add(layerListExpand, 'top-right')
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
      if (view && layerListExpand) {
        view.ui.remove(layerListExpand)
      }
      layerListExpand?.destroy()
      layerList?.destroy()
      view?.destroy()
    }
  }, [onError, onReady, webmapId])

  return (
    <div className={`map-host${isInteractionDisabled ? ' is-capture-locked' : ''}`}>
      <div className="map-container" inert={isInteractionDisabled} ref={containerRef} />
      {isInteractionDisabled && (
        <div className="map-capture-lock" role="status">
          <span className="spinner" aria-hidden="true" />
          Capturing from the fixed video viewport…
        </div>
      )}
      {isLoading && (
        <div className="map-loading" role="status">
          <span className="spinner" aria-hidden="true" />
          Loading public WebMap…
        </div>
      )}
    </div>
  )
}
