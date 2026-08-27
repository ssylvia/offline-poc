import Extent from '@arcgis/core/geometry/Extent.js'
import Viewpoint from '@arcgis/core/Viewpoint.js'
import MapView from '@arcgis/core/views/MapView.js'
import { watch } from '@arcgis/core/core/reactiveUtils.js'
import { useEffect, useRef, useState } from 'react'
import { getErrorMessage } from '../../../shared/format.ts'
import {
  activatePackageCache,
  deactivatePackageCache,
} from '../storage/service-worker-client.ts'
import type { SavedMapPackage } from '../types.ts'
import { buildOfflineWebMap } from './offline-map-builder.ts'

interface OfflineMapProps {
  onCoverageChange: (insideCoverage: boolean) => void
  onError: (message: string) => void
  onReady?: () => void
  packageRecord: SavedMapPackage
}

export function OfflineMap({
  onCoverageChange,
  onError,
  onReady,
  packageRecord,
}: OfflineMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let disposed = false
    let cacheActivated = false
    let view: MapView | undefined
    const handles: Array<{ remove: () => void }> = []

    const releaseResources = () => {
      handles.splice(0).forEach((handle) => handle.remove())
      view?.destroy()
      view = undefined
      if (cacheActivated) {
        cacheActivated = false
        deactivatePackageCache()
      }
    }

    const load = async () => {
      setIsLoading(true)
      await activatePackageCache(packageRecord)
      cacheActivated = true
      if (disposed) {
        releaseResources()
        return
      }

      const map = await buildOfflineWebMap(packageRecord)
      if (disposed || !containerRef.current) {
        map.destroy()
        releaseResources()
        return
      }

      const coverage = Extent.fromJSON(packageRecord.coverageExtent)
      view = new MapView({
        container: containerRef.current,
        map,
        viewpoint: Viewpoint.fromJSON(packageRecord.viewpoint),
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

      const updateCoverage = () => {
        if (!view?.extent) {
          return
        }
        const levelInRange = packageRecord.levels.length === 0
          || (view.zoom >= Math.min(...packageRecord.levels) - 0.5
            && view.zoom <= Math.max(...packageRecord.levels) + 0.5)
        onCoverageChange(coverage.contains(view.extent.center) && levelInRange)
      }
      handles.push(
        watch(() => view?.extent, updateCoverage),
        watch(() => view?.zoom, updateCoverage),
      )
      updateCoverage()
      setIsLoading(false)
      onReady?.()
    }

    void load().catch((error: unknown) => {
      releaseResources()
      if (!disposed) {
        setIsLoading(false)
        onError(getErrorMessage(error))
      }
    })

    return () => {
      disposed = true
      releaseResources()
    }
  }, [onCoverageChange, onError, onReady, packageRecord])

  return (
    <div className="map-host">
      <div className="map-container" ref={containerRef} />
      {isLoading && (
        <div className="map-loading" role="status">
          <span className="spinner" aria-hidden="true" />
          Reconstructing saved WebMap…
        </div>
      )}
    </div>
  )
}
