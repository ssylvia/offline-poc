import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react'
import { createUrl, readUrlState, type UrlState } from './app/url-state.ts'
import { useConnectivity } from './app/use-connectivity.ts'
import {
  defaultMapApproachId,
  getMapApproachDescriptor,
  mapApproaches,
} from './approaches/index.ts'
import { InteractiveOfflineJsSdkApproach } from './approaches/interactive-offline-js-sdk/InteractiveOfflineJsSdkApproach.tsx'
import { VideoOfflineApproach } from './approaches/offline-video/VideoOfflineApproach.tsx'
import type { MapApproachId } from './approaches/types.ts'

function App() {
  const isOnline = useConnectivity()
  const [search, setSearch] = useState(() => window.location.search)
  const [route, setRoute] = useState<UrlState>(() => readUrlState(window.location.search))

  useEffect(() => {
    const handlePopState = () => {
      setSearch(window.location.search)
      setRoute(readUrlState(window.location.search))
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  const navigate = useCallback((
    nextState: UrlState,
    options?: {
      replace?: boolean
    },
  ) => {
    const url = createUrl(nextState)
    if (options?.replace) {
      window.history.replaceState({}, '', url)
    } else {
      window.history.pushState({}, '', url)
    }
    setSearch(url.search)
    setRoute(readUrlState(url.search))
  }, [])

  const selectedApproach = useMemo(
    () => getMapApproachDescriptor(route.approachId),
    [route.approachId],
  )

  const handleApproachChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextApproachId = event.target.value as MapApproachId
    navigate({
      approachId: nextApproachId,
      mode: nextApproachId === defaultMapApproachId ? route.mode : 'live',
      savedVideoPackageId: nextApproachId === 'offline-video' ? route.savedVideoPackageId : undefined,
      webmapId: route.webmapId,
    })
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="app-header-copy">
          <p className="eyebrow">Prototype approaches</p>
          <h1>Offline ArcGIS WebMap Viewer</h1>
          <p>{selectedApproach.description}</p>
        </div>

        <div className="app-header-actions">
          <div className="approach-selector">
            <label htmlFor="approach-selector">Approach</label>
            <div className="approach-selector-control">
              <select
                id="approach-selector"
                aria-describedby="approach-selector-help"
                value={route.approachId}
                onChange={handleApproachChange}
              >
                {mapApproaches.map((approach) => (
                  <option key={approach.id} value={approach.id}>
                    {approach.label}
                  </option>
                ))}
              </select>
              <p id="approach-selector-help" className="approach-selector-help">
                Switch between bounded live snapshots and popup-aware offline video packages.
              </p>
            </div>
          </div>
          <div
            className={`connection-badge ${isOnline ? 'is-online' : 'is-offline'}`}
            role="status"
            aria-live="polite"
          >
            <span aria-hidden="true" />
            {isOnline ? 'Browser online' : 'Browser offline'}
          </div>
        </div>
      </header>

      {route.approachId === 'offline-video' ? (
        <VideoOfflineApproach isOnline={isOnline} onNavigate={navigate} route={route} />
      ) : (
        <InteractiveOfflineJsSdkApproach
          isOnline={isOnline}
          onNavigate={navigate}
          route={route}
          search={search}
        />
      )}
    </main>
  )
}

export default App
