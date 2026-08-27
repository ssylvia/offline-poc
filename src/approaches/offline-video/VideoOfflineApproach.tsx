import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { normalizeWebMapId, type UrlState } from '../../app/url-state.ts'
import {
  serializeArcGisJson,
  type LiveMapSession,
} from '../../shared/arcgis/index.ts'
import { formatBytes, formatDate, getErrorMessage } from '../../shared/format.ts'
import {
  countDraftWarningsByView,
  listDraftAssets,
  listDraftWarnings,
  removeDraftArtifacts,
  upsertDraftArtifacts,
  type DraftArtifactsByView,
} from './draft-state.ts'
import { offlineVideoApproach } from './descriptor.ts'
import { exportVideoPackage } from './export.ts'
import {
  deletePackage,
  getSavedPackage,
  getStorageEstimate,
  listAssets,
  listSavedPackages,
  removeStaleStagingPackages,
  requestPersistentStorage,
} from './storage/database.ts'
import type {
  PopupCaptureResult,
  SavedVideoPackage,
  VideoCaptureProgress,
  VideoCaptureWarning,
  VideoDraftView,
  VideoPackageAsset,
} from './types.ts'
import { OfflineVideoPlayer } from './ui/OfflineVideoPlayer.tsx'
import { SavedVideoLibrary } from './ui/SavedVideoLibrary.tsx'
import { VideoComposerPanel } from './ui/VideoComposerPanel.tsx'

interface VideoOfflineApproachProps {
  isOnline: boolean
  onNavigate: (
    state: UrlState,
    options?: {
      replace?: boolean
    },
  ) => void
  route: UrlState
}

const LazyVideoCaptureMap = lazy(async () => {
  const module = await import('./arcgis/VideoCaptureMap.tsx')
  return { default: module.VideoCaptureMap }
})

let liveCaptureSupportPromise: Promise<{
  captureLayerStates: typeof import('./capture/view-state.ts').captureLayerStates
  captureMapViewPopup: typeof import('./capture/popup.ts').captureMapViewPopup
  captureOfflineVideo: typeof import('./capture/capture-offline-video.ts').captureOfflineVideo
  getVideoOutputSize: typeof import('./capture/view-state.ts').getVideoOutputSize
  takeMapOnlyScreenshot: typeof import('./capture/view-state.ts').takeMapOnlyScreenshot
  waitForViewStable: typeof import('./capture/view-state.ts').waitForViewStable
}> | undefined

async function loadLiveCaptureSupport() {
  liveCaptureSupportPromise ??= Promise.all([
    import('./capture/capture-offline-video.ts'),
    import('./capture/popup.ts'),
    import('./capture/view-state.ts'),
  ]).then(([captureModule, popupModule, viewStateModule]) => ({
    captureLayerStates: viewStateModule.captureLayerStates,
    captureMapViewPopup: popupModule.captureMapViewPopup,
    captureOfflineVideo: captureModule.captureOfflineVideo,
    getVideoOutputSize: viewStateModule.getVideoOutputSize,
    takeMapOnlyScreenshot: viewStateModule.takeMapOnlyScreenshot,
    waitForViewStable: viewStateModule.waitForViewStable,
  }))
  return liveCaptureSupportPromise
}

function createId(prefix: string): string {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function createDraftAssetIdFactory(viewId: string): (kind: VideoPackageAsset['kind']) => string {
  let nextId = 1
  return (kind) => `${viewId}:${kind}:${nextId++}`
}

function resolveDraftViewName(name: string, index: number): string {
  const trimmed = name.trim()
  return trimmed === '' ? `View ${index + 1}` : trimmed
}

function replaceDraftView(views: VideoDraftView[], nextView: VideoDraftView): VideoDraftView[] {
  return views.map((view) => (view.id === nextView.id ? nextView : view))
}

function moveDraftView(
  views: VideoDraftView[],
  viewId: string,
  direction: -1 | 1,
): VideoDraftView[] {
  const index = views.findIndex((view) => view.id === viewId)
  const nextIndex = index + direction
  if (index < 0 || nextIndex < 0 || nextIndex >= views.length) {
    return views
  }
  const nextViews = [...views]
  const [moved] = nextViews.splice(index, 1)
  nextViews.splice(nextIndex, 0, moved)
  return nextViews
}

function createPopupCaptureWarning(viewId: string, error: unknown): VideoCaptureWarning {
  return {
    code: 'popup-asset-unavailable',
    message: `Popup content could not be retained for this view: ${getErrorMessage(error)}`,
    viewId,
  }
}

function storageSummary(estimate: StorageEstimate): string {
  if (!estimate.quota) {
    return 'Storage estimates are unavailable in this browser.'
  }
  return `${formatBytes(estimate.usage ?? 0)} used of ${formatBytes(estimate.quota)} available`
}

export function VideoOfflineApproach({
  isOnline,
  onNavigate,
  route,
}: VideoOfflineApproachProps) {
  const [initialRawId] = useState(
    () => new URLSearchParams(window.location.search).get('webmap') ?? '',
  )
  const previousWebMapId = useRef(route.webmapId)
  const captureController = useRef<AbortController | undefined>(undefined)
  const [inputValue, setInputValue] = useState(route.webmapId ?? initialRawId)
  const [liveSession, setLiveSession] = useState<LiveMapSession>()
  const [savedPackages, setSavedPackages] = useState<SavedVideoPackage[]>([])
  const [selectedPackage, setSelectedPackage] = useState<SavedVideoPackage>()
  const [selectedAssets, setSelectedAssets] = useState<VideoPackageAsset[]>([])
  const [draftViews, setDraftViews] = useState<VideoDraftView[]>([])
  const [draftArtifactsByView, setDraftArtifactsByView] = useState<DraftArtifactsByView>({})
  const [storageEstimate, setStorageEstimate] = useState<StorageEstimate>({})
  const [persistentStorage, setPersistentStorage] = useState<boolean>()
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(true)
  const [isRecordingView, setIsRecordingView] = useState(false)
  const [progress, setProgress] = useState<VideoCaptureProgress>()
  const [error, setError] = useState(() => (
    initialRawId && !route.webmapId
      ? 'The webmap query parameter must be a 32-character ArcGIS item ID.'
      : ''
  ))
  const [success, setSuccess] = useState('')

  const activeMode = route.savedVideoPackageId ? 'offline' : 'live'
  const isCapturing = progress !== undefined && progress.phase !== 'complete'
  const packagesForWebMap = useMemo(
    () => route.webmapId
      ? savedPackages.filter((packageRecord) => packageRecord.item.id === route.webmapId)
      : [],
    [route.webmapId, savedPackages],
  )
  const latestSavedForWebMap = packagesForWebMap[0]
  const draftAssets = useMemo(
    () => listDraftAssets(draftViews, draftArtifactsByView),
    [draftArtifactsByView, draftViews],
  )
  const draftWarnings = useMemo(
    () => listDraftWarnings(draftViews, draftArtifactsByView),
    [draftArtifactsByView, draftViews],
  )
  const warningCountByView = useMemo(
    () => countDraftWarningsByView(draftArtifactsByView),
    [draftArtifactsByView],
  )

  const navigateToComposer = useCallback((
    webmapId?: string,
    options?: {
      replace?: boolean
    },
  ) => {
    onNavigate({
      approachId: offlineVideoApproach.id,
      mode: 'live',
      savedVideoPackageId: undefined,
      webmapId,
    }, options)
  }, [onNavigate])

  const navigateToSavedVideo = useCallback((
    packageRecord: Pick<SavedVideoPackage, 'item' | 'packageId'>,
    options?: {
      replace?: boolean
    },
  ) => {
    onNavigate({
      approachId: offlineVideoApproach.id,
      mode: 'offline',
      savedVideoPackageId: packageRecord.packageId,
      webmapId: packageRecord.item.id,
    }, options)
  }, [onNavigate])

  const refreshPackages = useCallback(async (): Promise<SavedVideoPackage[]> => {
    const [packages, estimate] = await Promise.all([
      listSavedPackages(),
      getStorageEstimate(),
    ])
    setSavedPackages(packages)
    setStorageEstimate(estimate)
    return packages
  }, [])

  useEffect(() => {
    void (async () => {
      setIsLoadingLibrary(true)
      try {
        await removeStaleStagingPackages()
        await refreshPackages()
      } catch (loadError) {
        setError(`Saved videos could not be read: ${getErrorMessage(loadError)}`)
      } finally {
        setIsLoadingLibrary(false)
      }
    })()
  }, [refreshPackages])

  useEffect(() => {
    if (route.webmapId !== previousWebMapId.current) {
      previousWebMapId.current = route.webmapId
      setInputValue(route.webmapId ?? '')
      setDraftViews([])
      setDraftArtifactsByView({})
      setSelectedAssets([])
      setLiveSession(undefined)
      setPersistentStorage(undefined)
      setProgress(undefined)
      setSuccess('')
      if (!initialRawId || route.webmapId) {
        setError('')
      }
    } else if (route.webmapId) {
      setInputValue(route.webmapId)
    }
  }, [initialRawId, route.webmapId])

  useEffect(() => {
    if (route.savedVideoPackageId) {
      setLiveSession(undefined)
    }
  }, [route.savedVideoPackageId])

  useEffect(() => {
    let cancelled = false
    const packageId = route.savedVideoPackageId
    if (!packageId) {
      setSelectedPackage(undefined)
      return () => {
        cancelled = true
      }
    }

    void (async () => {
      try {
        const packageRecord = await getSavedPackage(packageId)
        if (!cancelled) {
          setSelectedPackage(packageRecord)
        }
      } catch (packageError) {
        if (!cancelled) {
          setError(`The saved video could not be loaded: ${getErrorMessage(packageError)}`)
          setSelectedPackage(undefined)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [route.savedVideoPackageId])

  useEffect(() => {
    if (!route.savedVideoPackageId) {
      setSelectedPackage(undefined)
      return
    }
    const fromLibrary = savedPackages.find(
      (packageRecord) => packageRecord.packageId === route.savedVideoPackageId,
    )
    if (fromLibrary) {
      setSelectedPackage(fromLibrary)
    }
  }, [route.savedVideoPackageId, savedPackages])

  useEffect(() => {
    let cancelled = false
    if (!selectedPackage) {
      setSelectedAssets([])
      return () => {
        cancelled = true
      }
    }
    setSelectedAssets([])

    void (async () => {
      try {
        const assets = await listAssets(selectedPackage.packageId)
        if (!cancelled) {
          setSelectedAssets(assets)
        }
      } catch (assetError) {
        if (!cancelled) {
          setError(`Saved popup assets could not be loaded: ${getErrorMessage(assetError)}`)
          setSelectedAssets([])
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [selectedPackage])

  useEffect(() => {
    return () => captureController.current?.abort()
  }, [])

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    const normalized = normalizeWebMapId(inputValue)
    if (!normalized) {
      setError('Enter a valid 32-character ArcGIS WebMap item ID.')
      return
    }

    setError('')
    setSuccess('')
    if (!isOnline) {
      const savedPackage = savedPackages.find((packageRecord) => packageRecord.item.id === normalized)
      if (savedPackage) {
        navigateToSavedVideo(savedPackage)
      } else {
        setError('No internet connection is available, and this WebMap has not been captured yet.')
      }
      return
    }

    navigateToComposer(normalized)
  }

  const handleLiveReady = useCallback((session: LiveMapSession) => {
    setLiveSession(session)
    setError('')
  }, [])

  const handleMapError = useCallback((message: string) => {
    setError(message)
  }, [])

  const captureCurrentPopup = useCallback(async (
    session: LiveMapSession,
    viewId: string,
  ): Promise<PopupCaptureResult> => {
    try {
      const { captureMapViewPopup } = await loadLiveCaptureSupport()
      return await captureMapViewPopup(session.view, {
        createAssetId: createDraftAssetIdFactory(viewId),
        packageId: `draft-${viewId}`,
        viewId,
      })
    } catch (captureError) {
      return {
        assets: [],
        warnings: [createPopupCaptureWarning(viewId, captureError)],
      }
    }
  }, [])

  const captureDraftView = useCallback(async (existingView?: VideoDraftView) => {
    if (!liveSession) {
      setError('Wait for the live WebMap to finish loading before saving a view.')
      return
    }

    const nextViewId = existingView?.id ?? createId('view')
    setIsRecordingView(true)
    setError('')
    setSuccess('')
    try {
      const {
        captureLayerStates,
        getVideoOutputSize,
        takeMapOnlyScreenshot,
        waitForViewStable,
      } = await loadLiveCaptureSupport()
      await waitForViewStable(liveSession.view)
      const popupResult = await captureCurrentPopup(liveSession, nextViewId)
      const outputSize = getVideoOutputSize(liveSession.view)
      const thumbnailBlob = await takeMapOnlyScreenshot(
        liveSession.view,
        outputSize,
      )
      if (!liveSession.view.extent) {
        throw new Error('The live WebMap does not expose an extent for capture.')
      }

      const nextView: VideoDraftView = {
        capturedAt: Date.now(),
        extent: serializeArcGisJson(liveSession.view.extent),
        id: nextViewId,
        layers: captureLayerStates(liveSession.map),
        name: existingView?.name ?? `View ${draftViews.length + 1}`,
        popup: popupResult.popup,
        thumbnailBlob,
        viewpoint: serializeArcGisJson(liveSession.view.viewpoint),
      }

      setDraftArtifactsByView((current) => upsertDraftArtifacts(current, nextViewId, popupResult))
      setDraftViews((current) => (
        existingView ? replaceDraftView(current, nextView) : [...current, nextView]
      ))
    } catch (captureError) {
      setError(`The current view could not be saved: ${getErrorMessage(captureError)}`)
    } finally {
      setIsRecordingView(false)
    }
  }, [captureCurrentPopup, draftViews.length, liveSession])

  const handleCapture = useCallback(async () => {
    if (!liveSession) {
      setError('Wait for the live WebMap to finish loading before creating a video.')
      return
    }
    if (draftViews.length === 0) {
      setError('Add at least one final view before creating a video.')
      return
    }

    const normalizedViews = draftViews.map((view, index) => ({
      ...view,
      name: resolveDraftViewName(view.name, index),
    }))
    const controller = new AbortController()
    captureController.current = controller
    setDraftViews(normalizedViews)
    setError('')
    setSuccess('')
    setProgress({
      completed: 0,
      detail: 'Requesting persistent browser storage',
      phase: 'preparing',
      total: 1,
    })

    try {
      const { captureOfflineVideo } = await loadLiveCaptureSupport()
      setPersistentStorage(await requestPersistentStorage())
      const completed = await captureOfflineVideo({
        assets: draftAssets,
        options: {
          onProgress: setProgress,
          signal: controller.signal,
        },
        packageId: createId('video-package'),
        session: liveSession,
        views: normalizedViews,
        warnings: draftWarnings,
      })
      await refreshPackages()
      setSuccess(`${completed.item.title} is ready for offline playback.`)
    } catch (captureError) {
      if (controller.signal.aborted) {
        setError('Video capture cancelled. The incomplete staging package was removed.')
      } else {
        setError(`Offline video capture failed: ${getErrorMessage(captureError)}`)
      }
      setProgress(undefined)
    } finally {
      captureController.current = undefined
      setStorageEstimate(await getStorageEstimate())
    }
  }, [draftAssets, draftViews, draftWarnings, liveSession, refreshPackages])

  const openSaved = useCallback((packageRecord: SavedVideoPackage) => {
    setError('')
    setSuccess('')
    navigateToSavedVideo(packageRecord)
  }, [navigateToSavedVideo])

  const recaptureSaved = useCallback((packageRecord: SavedVideoPackage) => {
    if (!isOnline) {
      setError('Reconnect to the internet before recapturing this WebMap as a video.')
      return
    }
    setError('')
    setSuccess('')
    navigateToComposer(packageRecord.item.id)
  }, [isOnline, navigateToComposer])

  const exportSaved = useCallback(async (packageRecord: SavedVideoPackage) => {
    setError('')
    setSuccess('')
    try {
      await exportVideoPackage(packageRecord, await listAssets(packageRecord.packageId))
      setSuccess(`${packageRecord.item.title} was exported.`)
    } catch (exportError) {
      setError(`The saved video could not be exported: ${getErrorMessage(exportError)}`)
    }
  }, [])

  const removeSaved = useCallback(async (packageRecord: SavedVideoPackage) => {
    if (!window.confirm(`Delete the offline video for “${packageRecord.item.title}”?`)) {
      return
    }

    setError('')
    setSuccess('')
    try {
      await deletePackage(packageRecord.packageId)
      const remainingPackages = await refreshPackages()
      if (route.savedVideoPackageId === packageRecord.packageId) {
        const replacement = remainingPackages.find(
          (entry) => entry.item.id === packageRecord.item.id,
        )
        if (!isOnline && replacement) {
          navigateToSavedVideo(replacement, { replace: true })
        } else {
          navigateToComposer(packageRecord.item.id, { replace: true })
        }
      }
    } catch (deleteError) {
      setError(`The saved video could not be deleted: ${getErrorMessage(deleteError)}`)
    }
  }, [isOnline, navigateToComposer, navigateToSavedVideo, refreshPackages, route.savedVideoPackageId])

  return (
    <div className="workspace">
      <aside className="control-panel">
        <section aria-labelledby="video-approach-heading">
          <div className="section-heading">
            <h2 id="video-approach-heading">Open a public WebMap</h2>
          </div>
          <p className="scope-copy">
            Capture an ordered set of final views from a live WebMap, then render them into an
            offline video package that stays in this browser.
          </p>
          <form className="item-form" onSubmit={handleSubmit}>
            <label htmlFor="video-webmap-id">ArcGIS WebMap item ID</label>
            <div className="input-row">
              <input
                id="video-webmap-id"
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
          <p className="muted-copy">
            {isOnline
              ? 'Keep the browser online while loading a new WebMap or recapturing popup assets.'
              : 'The browser is offline. Previously saved videos remain routable and playable here.'}
          </p>
          <p className="legal-copy">
            Creating a video package requires browser WebM encoding support. This prototype is
            currently targeted at desktop Chrome and Edge.
          </p>
          {route.webmapId && (
            <div className="current-map-actions">
              {activeMode === 'live' && latestSavedForWebMap && (
                <button
                  type="button"
                  className="button button-secondary button-wide"
                  disabled={isCapturing || isRecordingView}
                  onClick={() => openSaved(latestSavedForWebMap)}
                >
                  Open latest saved video
                </button>
              )}
              {activeMode === 'offline' && (
                <button
                  type="button"
                  className="button button-secondary button-wide"
                  disabled={isCapturing}
                  onClick={() => navigateToComposer(selectedPackage?.item.id ?? route.webmapId)}
                >
                  Return to live WebMap
                </button>
              )}
            </div>
          )}
        </section>

        {error && (
          <div className="alert alert-error" role="alert">
            <strong>Something needs attention</strong>
            <p>{error}</p>
            {activeMode === 'live' && latestSavedForWebMap && (
              <button type="button" onClick={() => openSaved(latestSavedForWebMap)}>
                Open the latest saved video instead
              </button>
            )}
          </div>
        )}
        {success && (
          <div className="alert alert-success" role="status">
            <strong>Saved video ready</strong>
            <p>{success}</p>
          </div>
        )}

        {(route.webmapId || draftViews.length > 0) && (
          <VideoComposerPanel
            isCapturing={isCapturing}
            isReady={activeMode === 'live' && liveSession !== undefined}
            isRecordingView={isRecordingView}
            onAdd={() => void captureDraftView()}
            onCancel={() => captureController.current?.abort()}
            onCapture={() => void handleCapture()}
            onMove={(viewId, direction) => setDraftViews((current) => moveDraftView(current, viewId, direction))}
            onRemove={(viewId) => {
              setDraftViews((current) => current.filter((view) => view.id !== viewId))
              setDraftArtifactsByView((current) => removeDraftArtifacts(current, viewId))
            }}
            onRename={(viewId, name) => {
              setDraftViews((current) => current.map((view) => (
                view.id === viewId ? { ...view, name } : view
              )))
            }}
            onUpdate={(viewId) => {
              const existingView = draftViews.find((view) => view.id === viewId)
              if (!existingView) {
                setError('That draft view could not be found for updating.')
                return
              }
              void captureDraftView(existingView)
            }}
            progress={progress}
            totalWarningCount={draftWarnings.length}
            views={draftViews}
            warningCountByView={warningCountByView}
          />
        )}

        <section aria-labelledby="video-storage-heading">
          <div className="section-heading">
            <h2 id="video-storage-heading">Browser storage</h2>
          </div>
          <p className="scope-copy">
            Saved videos, popup assets, and temporary frames stay in browser-managed storage.
          </p>
          <p className="muted-copy">{storageSummary(storageEstimate)}</p>
          <p className="legal-copy">
            There is no fixed view limit, but more views and larger map sizes increase temporary
            storage pressure during capture.
          </p>
          {persistentStorage !== undefined && (
            <p className={persistentStorage ? 'success-text' : 'warning-text'}>
              {persistentStorage
                ? 'Persistent storage was granted for saved videos.'
                : 'Persistent storage is not granted; saved videos may be evicted under storage pressure.'}
            </p>
          )}
          {route.savedVideoPackageId && (
            <p className="muted-copy">
              Routed saved package:
              {' '}
              <strong>{route.savedVideoPackageId}</strong>
            </p>
          )}
        </section>

        <SavedVideoLibrary
          packages={savedPackages}
          onDelete={(packageRecord) => void removeSaved(packageRecord)}
          onExport={(packageRecord) => void exportSaved(packageRecord)}
          onOpen={openSaved}
          onRecapture={recaptureSaved}
        />
      </aside>

      <section className="map-panel" aria-label="Map viewer">
        {activeMode === 'offline' && selectedPackage && (
          <div className="map-status-bar">
            <span className="offline-pill">Offline video</span>
            <span>Saved {formatDate(selectedPackage.completedAt ?? selectedPackage.createdAt)}</span>
            {selectedPackage.warnings.length > 0 && (
              <span className="degraded-pill">
                {selectedPackage.warnings.length} warning{selectedPackage.warnings.length === 1 ? '' : 's'}
              </span>
            )}
          </div>
        )}

        {activeMode === 'live' && route.webmapId && isOnline && (
          <Suspense
            fallback={(
              <div className="map-empty">
                <span className="spinner" aria-hidden="true" />
                <h2>Loading public WebMap…</h2>
                <p>Preparing the live map tools needed for capture.</p>
              </div>
            )}
          >
            <LazyVideoCaptureMap
              key={route.webmapId}
              webmapId={route.webmapId}
              onError={handleMapError}
              onReady={handleLiveReady}
            />
          </Suspense>
        )}
        {activeMode === 'offline' && selectedPackage && (
          <OfflineVideoPlayer
            key={selectedPackage.packageId}
            assets={selectedAssets}
            onError={handleMapError}
            packageRecord={selectedPackage}
          />
        )}
        {activeMode === 'offline' && route.savedVideoPackageId && !selectedPackage && isLoadingLibrary && (
          <div className="map-empty">
            <span className="spinner" aria-hidden="true" />
            <h2>Loading saved video…</h2>
            <p>The routed video package is being read from browser storage.</p>
          </div>
        )}
        {activeMode === 'offline' && route.savedVideoPackageId && !selectedPackage && !isLoadingLibrary && (
          <div className="map-empty">
            <div className="empty-map-icon" aria-hidden="true">×</div>
            <h2>Saved video not found</h2>
            <p>This routed video package is not available in this browser.</p>
          </div>
        )}
        {activeMode === 'live' && route.webmapId && !isOnline && !latestSavedForWebMap && (
          <div className="map-empty">
            <div className="empty-map-icon" aria-hidden="true">!</div>
            <h2>Internet connection required</h2>
            <p>Reconnect to load this WebMap, or open one of the saved videos from the library.</p>
          </div>
        )}
        {activeMode === 'live' && route.webmapId && !isOnline && latestSavedForWebMap && (
          <div className="map-empty">
            <div className="empty-map-icon" aria-hidden="true">▶</div>
            <h2>Open a saved video instead</h2>
            <p>The browser is offline. A previously captured video for this WebMap is available.</p>
            <button type="button" className="button" onClick={() => openSaved(latestSavedForWebMap)}>
              Play latest saved video
            </button>
          </div>
        )}
        {!route.webmapId && !route.savedVideoPackageId && (
          <div className="map-empty">
            <div className="empty-map-icon" aria-hidden="true">▶</div>
            <h2>{isOnline ? 'Load a WebMap to begin' : 'Choose a saved video'}</h2>
            <p>
              {isOnline
                ? 'Paste the item ID of a public ArcGIS WebMap, then capture popup-aware final views in playback order.'
                : 'The browser is offline. Videos already captured on this device remain available in the library.'}
            </p>
          </div>
        )}
      </section>
    </div>
  )
}
