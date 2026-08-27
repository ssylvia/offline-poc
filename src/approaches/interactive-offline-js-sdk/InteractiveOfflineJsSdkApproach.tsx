import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { normalizeWebMapId, type UrlState, type ViewerMode } from '../../app/url-state.ts'
import { formatDate, getErrorMessage } from '../../shared/format.ts'
import { interactiveOfflineJsSdkApproach } from './descriptor.ts'
import { LiveMap } from './arcgis/LiveMap.tsx'
import { OfflineMap } from './arcgis/OfflineMap.tsx'
import { downloadOfflineMap } from './download/downloader.ts'
import { createPreflightReport } from './download/preflight.ts'
import {
  deletePackage,
  getStorageEstimate,
  listSavedPackages,
  removeStaleStagingPackages,
  requestPersistentStorage,
} from './storage/database.ts'
import type {
  DownloadProgress,
  LiveMapSession,
  PreflightReport,
  SavedMapPackage,
} from './types.ts'
import { DownloadPanel } from './ui/DownloadPanel.tsx'
import { SavedMapLibrary } from './ui/SavedMapLibrary.tsx'

interface InteractiveOfflineJsSdkApproachProps {
  isOnline: boolean
  onNavigate: (
    state: UrlState,
    options?: {
      replace?: boolean
    },
  ) => void
  route: UrlState
  search: string
}

export function InteractiveOfflineJsSdkApproach({
  isOnline,
  onNavigate,
  route,
  search,
}: InteractiveOfflineJsSdkApproachProps) {
  const [initialRawId] = useState(() => new URLSearchParams(search).get('webmap') ?? '')
  const [mode, setMode] = useState<ViewerMode>(route.mode)
  const [webmapId, setWebmapId] = useState(route.webmapId)
  const [inputValue, setInputValue] = useState(initialRawId)
  const [liveSession, setLiveSession] = useState<LiveMapSession>()
  const [packages, setPackages] = useState<SavedMapPackage[]>([])
  const [preflight, setPreflight] = useState<PreflightReport>()
  const [storageEstimate, setStorageEstimate] = useState<StorageEstimate>({})
  const [persistentStorage, setPersistentStorage] = useState<boolean>()
  const [allowDegraded, setAllowDegraded] = useState(false)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [progress, setProgress] = useState<DownloadProgress>()
  const [error, setError] = useState(() => (
    initialRawId && !route.webmapId
      ? 'The webmap query parameter must be a 32-character ArcGIS item ID.'
      : ''
  ))
  const [success, setSuccess] = useState('')
  const [insideCoverage, setInsideCoverage] = useState(true)
  const downloadController = useRef<AbortController | undefined>(undefined)

  const selectedPackage = packages.find(
    (packageRecord) => packageRecord.item.id === webmapId,
  )
  const activeMode: ViewerMode = !isOnline && webmapId && selectedPackage
    ? 'offline'
    : mode
  const isDownloading = progress !== undefined && progress.phase !== 'complete'

  const refreshPackages = useCallback(async () => {
    setPackages(await listSavedPackages())
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        await removeStaleStagingPackages()
        await refreshPackages()
      } catch (loadError) {
        setError(`Saved maps could not be read: ${getErrorMessage(loadError)}`)
      }
    })()
  }, [refreshPackages])

  useEffect(() => {
    setMode(route.mode)
    setWebmapId(route.webmapId)
    setInputValue(route.webmapId ?? '')
    setLiveSession(undefined)
    setPreflight(undefined)
  }, [route.mode, route.webmapId])

  const navigate = useCallback((nextMode: ViewerMode, nextId?: string) => {
    onNavigate({
      approachId: interactiveOfflineJsSdkApproach.id,
      mode: nextMode,
      webmapId: nextId,
    })
    setMode(nextMode)
    setWebmapId(nextId)
    setInputValue(nextId ?? '')
    setLiveSession(undefined)
    setPreflight(undefined)
    setProgress(undefined)
    setPersistentStorage(undefined)
    setAllowDegraded(false)
    setInsideCoverage(true)
    setError('')
    setSuccess('')
  }, [onNavigate])

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    const normalized = normalizeWebMapId(inputValue)
    if (!normalized) {
      setError('Enter a valid 32-character ArcGIS WebMap item ID.')
      return
    }

    const saved = packages.find((packageRecord) => packageRecord.item.id === normalized)
    if (!isOnline) {
      if (saved) {
        navigate('offline', normalized)
      } else {
        setError('No internet connection is available, and this WebMap has not been saved.')
      }
      return
    }
    navigate('live', normalized)
  }

  const handleLiveReady = useCallback((session: LiveMapSession) => {
    setLiveSession(session)
    setError('')
  }, [])

  const handleMapError = useCallback((message: string) => {
    if (mode === 'live' && selectedPackage && webmapId) {
      setError(`The live map is unavailable. Showing the saved snapshot instead. ${message}`)
      setMode('offline')
      onNavigate(
        {
          approachId: interactiveOfflineJsSdkApproach.id,
          mode: 'offline',
          webmapId,
        },
        { replace: true },
      )
      return
    }
    setError(message)
  }, [mode, onNavigate, selectedPackage, webmapId])

  const analyzeDownload = async () => {
    if (!liveSession) {
      setError('Wait for the live WebMap to finish loading.')
      return
    }

    setIsAnalyzing(true)
    setError('')
    setSuccess('')
    try {
      const [report, estimate] = await Promise.all([
        createPreflightReport(liveSession),
        getStorageEstimate(),
      ])
      setPreflight(report)
      setStorageEstimate(estimate)
      setAllowDegraded(false)
    } catch (analysisError) {
      setError(`Download preflight failed: ${getErrorMessage(analysisError)}`)
    } finally {
      setIsAnalyzing(false)
    }
  }

  const startDownload = async () => {
    if (!liveSession || !preflight) {
      setError('Run the download preflight first.')
      return
    }

    const controller = new AbortController()
    downloadController.current = controller
    setError('')
    setSuccess('')
    setProgress({
      completed: 0,
      detail: 'Requesting persistent browser storage',
      phase: 'preparing',
      total: 1,
    })

    try {
      setPersistentStorage(await requestPersistentStorage())
      const completed = await downloadOfflineMap(liveSession, preflight, {
        allowDegraded,
        onProgress: setProgress,
        signal: controller.signal,
      })
      await refreshPackages()
      setSuccess(`${completed.item.title} is ready for offline use.`)
    } catch (downloadError) {
      if (controller.signal.aborted) {
        setError('Download cancelled. The incomplete staging package was removed.')
      } else {
        setError(`Offline download failed: ${getErrorMessage(downloadError)}`)
      }
      setProgress(undefined)
    } finally {
      downloadController.current = undefined
    }
  }

  const openOffline = useCallback((packageRecord: SavedMapPackage) => {
    navigate('offline', packageRecord.item.id)
  }, [navigate])

  const updateSaved = useCallback((packageRecord: SavedMapPackage) => {
    if (!navigator.onLine) {
      setError('Reconnect to the internet before updating this snapshot.')
      return
    }
    navigate('live', packageRecord.item.id)
  }, [navigate])

  const removeSaved = useCallback(async (packageRecord: SavedMapPackage) => {
    if (!window.confirm(`Delete the offline snapshot of “${packageRecord.item.title}”?`)) {
      return
    }
    try {
      await deletePackage(packageRecord)
      await refreshPackages()
      if (mode === 'offline' && webmapId === packageRecord.item.id) {
        navigate('live')
      }
    } catch (deleteError) {
      setError(`The saved map could not be deleted: ${getErrorMessage(deleteError)}`)
    }
  }, [mode, navigate, refreshPackages, webmapId])

  const handleCoverageChange = useCallback((value: boolean) => {
    setInsideCoverage(value)
  }, [])

  return (
    <div className="workspace">
      <aside className="control-panel">
        <section aria-labelledby="load-map-heading">
          <div className="section-heading">
            <h2 id="load-map-heading">Open a public WebMap</h2>
          </div>
          <form className="item-form" onSubmit={handleSubmit}>
            <label htmlFor="webmap-id">ArcGIS WebMap item ID</label>
            <div className="input-row">
              <input
                id="webmap-id"
                autoComplete="off"
                inputMode="text"
                placeholder="32-character item ID"
                spellCheck="false"
                value={inputValue}
                onChange={(event) => setInputValue(event.target.value)}
              />
              <button type="submit" className="button">Load</button>
            </div>
          </form>

          {webmapId && (
            <div className="current-map-actions">
              {activeMode === 'live' && liveSession && (
                <button
                  type="button"
                  className="button button-wide"
                  disabled={isAnalyzing || isDownloading}
                  onClick={() => void analyzeDownload()}
                >
                  {isAnalyzing ? 'Analyzing map…' : selectedPackage ? 'Replace offline snapshot' : 'Download map'}
                </button>
              )}
              {activeMode === 'live' && selectedPackage && (
                <button
                  type="button"
                  className="button button-secondary button-wide"
                  onClick={() => openOffline(selectedPackage)}
                >
                  Open saved snapshot
                </button>
              )}
              {activeMode === 'offline' && isOnline && (
                <button
                  type="button"
                  className="button button-secondary button-wide"
                  onClick={() => navigate('live', webmapId)}
                >
                  Return to live map
                </button>
              )}
            </div>
          )}
        </section>

        {error && (
          <div className="alert alert-error" role="alert">
            <strong>Something needs attention</strong>
            <p>{error}</p>
            {activeMode === 'live' && selectedPackage && (
              <button type="button" onClick={() => openOffline(selectedPackage)}>
                Open saved snapshot instead
              </button>
            )}
          </div>
        )}
        {success && (
          <div className="alert alert-success" role="status">
            <strong>Download complete</strong>
            <p>{success}</p>
          </div>
        )}

        {preflight && (
          <DownloadPanel
            allowDegraded={allowDegraded}
            isDownloading={isDownloading}
            onAllowDegradedChange={setAllowDegraded}
            onCancel={() => downloadController.current?.abort()}
            onClose={() => {
              setPreflight(undefined)
              setProgress(undefined)
            }}
            onDownload={() => void startDownload()}
            persistentStorage={persistentStorage}
            progress={progress}
            report={preflight}
            storageEstimate={storageEstimate}
          />
        )}

        <SavedMapLibrary
          packages={packages}
          onDelete={(packageRecord) => void removeSaved(packageRecord)}
          onOpen={openOffline}
          onUpdate={updateSaved}
        />
      </aside>

      <section className="map-panel" aria-label="Map viewer">
        {activeMode === 'offline' && selectedPackage && (
          <div className="map-status-bar">
            <span className="offline-pill">Offline snapshot</span>
            <span>Saved {formatDate(selectedPackage.completedAt ?? selectedPackage.createdAt)}</span>
            {selectedPackage.compatibility.some((entry) => entry.level !== 'supported') && (
              <span className="degraded-pill">Partial content</span>
            )}
          </div>
        )}
        {activeMode === 'offline' && selectedPackage && !insideCoverage && (
          <div className="coverage-warning" role="status">
            This view is outside the downloaded extent or zoom levels. Missing content is expected.
          </div>
        )}

        {activeMode === 'live' && webmapId && isOnline && (
          <LiveMap
            key={webmapId}
            webmapId={webmapId}
            onError={handleMapError}
            onReady={handleLiveReady}
          />
        )}
        {activeMode === 'offline' && selectedPackage && (
          <OfflineMap
            key={selectedPackage.packageId}
            packageRecord={selectedPackage}
            onCoverageChange={handleCoverageChange}
            onError={handleMapError}
          />
        )}
        {activeMode === 'offline' && webmapId && !selectedPackage && (
          <div className="map-empty">
            <div className="empty-map-icon" aria-hidden="true">×</div>
            <h2>Snapshot not found</h2>
            <p>This WebMap has not been downloaded in this browser.</p>
          </div>
        )}
        {activeMode === 'live' && webmapId && !isOnline && !selectedPackage && (
          <div className="map-empty">
            <div className="empty-map-icon" aria-hidden="true">!</div>
            <h2>Internet connection required</h2>
            <p>Reconnect to preview this WebMap, or choose a saved map from the library.</p>
          </div>
        )}
        {!webmapId && (
          <div className="map-empty">
            <div className="map-grid" aria-hidden="true" />
            <h2>{isOnline ? 'Load a WebMap to begin' : 'Choose a saved map'}</h2>
            <p>
              {isOnline
                ? 'Paste the item ID of a public ArcGIS WebMap. The live default extent becomes the center of its offline snapshot.'
                : 'The browser is offline. Maps downloaded on this device remain available in the list.'}
            </p>
          </div>
        )}
      </section>
    </div>
  )
}
