import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatBytes } from '../../../shared/format.ts'
import { useObjectUrl, useObjectUrlMap } from '../../../shared/use-object-url.ts'
import type {
  CapturedPopup,
  CapturedPopupContent,
  SavedVideoPackage,
  VideoPackageAsset,
  VideoTimelineScene,
} from '../types.ts'
import { getContainedMediaRect, type MediaContentRect } from './video-layout.ts'

interface OfflineVideoPlayerProps {
  assets: VideoPackageAsset[]
  onError: (message: string) => void
  packageRecord: SavedVideoPackage
}

function replaceAssetTokens(html: string, assetUrls: Map<string, string>): string {
  return html.replace(/offline-asset:([a-zA-Z0-9:_-]+)/g, (token, assetId: string) => (
    assetUrls.get(assetId) ?? token
  ))
}

function getPlainText(html: string): string {
  if (typeof document === 'undefined') {
    return html.trim()
  }
  const template = document.createElement('template')
  template.innerHTML = html
  return template.content.textContent?.replace(/\s+/g, ' ').trim() ?? ''
}

function describeChartData(chartData: unknown): string {
  if (chartData === undefined) {
    return 'No chart data is available.'
  }
  return `Chart data: ${JSON.stringify(chartData)}`
}

function TrustedHtml({
  assetUrls,
  className,
  element,
  html,
}: {
  assetUrls: Map<string, string>
  className?: string
  element: 'div' | 'figcaption' | 'h3' | 'h4' | 'p' | 'span' | 'strong' | 'summary'
  html: string
}) {
  const Tag = element
  return (
    <Tag
      className={className}
      dangerouslySetInnerHTML={{ __html: replaceAssetTokens(html, assetUrls) }}
    />
  )
}

function getPopupCardStyle(
  popup: CapturedPopup,
  contentRect: MediaContentRect,
): {
  anchorStyle: { left: number; top: number }
  cardStyle: { maxHeight: number; maxWidth: number; transform: string }
} {
  const left = contentRect.left + popup.anchor.x * contentRect.width
  const top = contentRect.top + popup.anchor.y * contentRect.height
  const placeLeft = popup.anchor.x > 0.55
  const placeAbove = popup.anchor.y > 0.55
  const horizontalPadding = 12
  const verticalPadding = 12
  const maxWidth = Math.max(
    180,
    (placeLeft ? left - contentRect.left : contentRect.left + contentRect.width - left)
      - horizontalPadding,
  )
  const maxHeight = Math.max(
    140,
    (placeAbove ? top - contentRect.top : contentRect.top + contentRect.height - top)
      - verticalPadding,
  )

  return {
    anchorStyle: { left, top },
    cardStyle: {
      maxHeight,
      maxWidth,
      transform: `translate(${placeLeft ? 'calc(-100% - 10px)' : '10px'}, ${placeAbove ? 'calc(-100% - 10px)' : '10px'})`,
    },
  }
}

function PopupContent({
  assetUrls,
  content,
}: {
  assetUrls: Map<string, string>
  content: CapturedPopupContent
}) {
  if (content.type === 'fields') {
    return (
      <section className="video-popup-section">
        {content.title && <TrustedHtml assetUrls={assetUrls} element="h4" html={content.title} />}
        {content.description && <TrustedHtml assetUrls={assetUrls} element="p" html={content.description} />}
        <dl className="video-popup-fields">
          {content.fields.map((field) => (
            <div key={field.fieldName}>
              <dt>{field.label}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>
      </section>
    )
  }
  if (content.type === 'html') {
    return (
      <TrustedHtml
        assetUrls={assetUrls}
        className="video-popup-html"
        element="div"
        html={content.html}
      />
    )
  }
  if (content.type === 'media') {
    return (
      <section className="video-popup-section">
        {content.title && <TrustedHtml assetUrls={assetUrls} element="h4" html={content.title} />}
        {content.items.map((item, index) => (
          <figure key={`${item.title ?? item.kind}-${index}`} className="video-popup-media">
            {item.assetId && assetUrls.get(item.assetId) ? (
              <img
                src={assetUrls.get(item.assetId)}
                alt={getPlainText(item.alt ?? item.title ?? item.kind.replaceAll('-', ' '))}
              />
            ) : (
              <div
                className="video-popup-chart"
                role="img"
                aria-label={`${getPlainText(item.title ?? item.kind.replaceAll('-', ' '))}. ${describeChartData(item.chartData)}`}
              >
                {item.title
                  ? <TrustedHtml assetUrls={assetUrls} element="strong" html={item.title} />
                  : <strong>{item.kind.replaceAll('-', ' ')}</strong>}
                {item.chartData && <pre aria-hidden="true">{JSON.stringify(item.chartData, null, 2)}</pre>}
              </div>
            )}
            {(item.title || item.caption || item.link) && (
              <figcaption>
                {item.title && <TrustedHtml assetUrls={assetUrls} element="strong" html={item.title} />}
                {item.caption && <TrustedHtml assetUrls={assetUrls} element="span" html={item.caption} />}
                {item.link && (
                  <a href={item.link} rel="noreferrer noopener" target="_blank">
                    Open media source
                  </a>
                )}
              </figcaption>
            )}
          </figure>
        ))}
      </section>
    )
  }
  if (content.type === 'attachments') {
    return (
      <section className="video-popup-section">
        {content.title && <TrustedHtml assetUrls={assetUrls} element="h4" html={content.title} />}
        <ul className="video-popup-attachments">
          {content.items.map((item) => (
            <li key={item.assetId}>
              {assetUrls.get(item.assetId) ? (
                <a href={assetUrls.get(item.assetId)} download={item.name}>
                  {item.name}
                </a>
              ) : (
                <span>{item.name}</span>
              )}
              <span>{item.contentType} · {formatBytes(item.size)}</span>
              {!assetUrls.get(item.assetId) && <span className="warning-text">Unavailable offline</span>}
            </li>
          ))}
        </ul>
      </section>
    )
  }
  if (content.type === 'relationship') {
    return (
      <section className="video-popup-section">
        {content.title && <TrustedHtml assetUrls={assetUrls} element="h4" html={content.title} />}
        {content.records.map((record, index) => (
          <details key={`${record.title}-${index}`}>
            <summary>
              <TrustedHtml assetUrls={assetUrls} element="span" html={record.title} />
            </summary>
            <dl className="video-popup-fields">
              {record.fields.map((field) => (
                <div key={field.fieldName}>
                  <dt>{field.label}</dt>
                  <dd>{field.value}</dd>
                </div>
              ))}
            </dl>
          </details>
        ))}
      </section>
    )
  }
  if (content.type === 'expression') {
    return (
      <section className="video-popup-section">
        {content.title && <TrustedHtml assetUrls={assetUrls} element="h4" html={content.title} />}
        {content.content.map((entry, index) => (
          <PopupContent key={index} assetUrls={assetUrls} content={entry} />
        ))}
      </section>
    )
  }

  const fallbackUrl = assetUrls.get(content.assetId)
  return (
    <figure className="video-popup-fallback">
      {fallbackUrl ? (
        <img src={fallbackUrl} alt={`Popup fallback image. ${content.reason}`} />
      ) : (
        <p>Popup fallback image is unavailable offline.</p>
      )}
      <figcaption>Static popup fallback: {content.reason}</figcaption>
    </figure>
  )
}

function VideoPopup({
  assetUrls,
  cardStyle,
  popup,
}: {
  assetUrls: Map<string, string>
  cardStyle: { maxHeight: number; maxWidth: number; transform: string }
  popup: CapturedPopup
}) {
  return (
    <article
      className="video-popup-card"
      role="dialog"
      aria-label={getPlainText(popup.title) || 'Captured popup'}
      aria-modal="false"
      tabIndex={0}
      style={cardStyle}
    >
      <TrustedHtml assetUrls={assetUrls} element="h3" html={popup.title} />
      {popup.content.map((content, index) => (
        <PopupContent key={index} assetUrls={assetUrls} content={content} />
      ))}
      {popup.fallbackReasons.length > 0 && (
        <p className="warning-text">{popup.fallbackReasons.join(' ')}</p>
      )}
    </article>
  )
}

function findActiveScene(
  scenes: VideoTimelineScene[],
  currentTimeMs: number,
): VideoTimelineScene | undefined {
  return scenes.find((scene) => (
    currentTimeMs >= scene.holdStartMs && currentTimeMs < scene.holdEndMs
  ))
}

export function OfflineVideoPlayer({
  assets,
  onError,
  packageRecord,
}: OfflineVideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [currentTimeMs, setCurrentTimeMs] = useState(0)
  const [navigationTargetIndex, setNavigationTargetIndex] = useState<number>()
  const [contentRect, setContentRect] = useState<MediaContentRect>({
    height: 0,
    left: 0,
    top: 0,
    width: 0,
  })
  const videoUrl = useObjectUrl(packageRecord.videoBlob)
  const assetBlobs = useMemo(
    () => assets.map((asset) => [asset.assetId, asset.blob] as const),
    [assets],
  )
  const assetUrls = useObjectUrlMap(assetBlobs)

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) {
      return
    }
    const updateRect = () => {
      setContentRect(getContainedMediaRect(
        stage.clientWidth,
        stage.clientHeight,
        packageRecord.width,
        packageRecord.height,
      ))
    }
    const observer = new ResizeObserver(updateRect)
    observer.observe(stage)
    updateRect()
    return () => observer.disconnect()
  }, [packageRecord.height, packageRecord.width, videoUrl])

  const activeScene = findActiveScene(packageRecord.scenes, currentTimeMs)
  const activeSceneIndex = activeScene?.index ?? packageRecord.scenes.findLastIndex(
    (scene) => currentTimeMs >= scene.timestampMs,
  )
  const displayedSceneIndex = navigationTargetIndex ?? activeSceneIndex

  const stopAtScene = useCallback((
    video: HTMLVideoElement,
    scene: VideoTimelineScene,
  ) => {
    video.pause()
    video.currentTime = scene.timestampMs / 1_000
    setCurrentTimeMs(scene.timestampMs)
    setNavigationTargetIndex(undefined)
  }, [])

  const navigateToScene = useCallback((scene: VideoTimelineScene) => {
    const video = videoRef.current
    if (!video) {
      return
    }
    if (scene.index <= activeSceneIndex) {
      stopAtScene(video, scene)
      return
    }

    const currentScene = activeScene ?? packageRecord.scenes[activeSceneIndex]
    setNavigationTargetIndex(scene.index)
    if (
      currentScene
      && video.currentTime * 1_000 < currentScene.holdEndMs
    ) {
      video.currentTime = currentScene.holdEndMs / 1_000
      setCurrentTimeMs(currentScene.holdEndMs)
    }
    void video.play().catch(() => {
      setNavigationTargetIndex(undefined)
      onError('The saved video could not play the transition to the selected view.')
    })
  }, [activeScene, activeSceneIndex, onError, packageRecord.scenes, stopAtScene])

  const handleTimeUpdate = useCallback((video: HTMLVideoElement) => {
    const nextTimeMs = video.currentTime * 1_000
    setCurrentTimeMs(nextTimeMs)
    if (navigationTargetIndex === undefined) {
      return
    }
    const targetScene = packageRecord.scenes[navigationTargetIndex]
    if (!targetScene) {
      setNavigationTargetIndex(undefined)
      return
    }
    const frameToleranceMs = 1_000 / Math.max(1, packageRecord.frameRate)
    if (nextTimeMs >= targetScene.holdStartMs - frameToleranceMs) {
      stopAtScene(video, targetScene)
      return
    }

    const intermediateHold = packageRecord.scenes.find((scene) => (
      scene.index < targetScene.index
      && nextTimeMs >= scene.holdStartMs
      && nextTimeMs < scene.holdEndMs
    ))
    if (intermediateHold) {
      video.currentTime = intermediateHold.holdEndMs / 1_000
      setCurrentTimeMs(intermediateHold.holdEndMs)
    }
  }, [
    navigationTargetIndex,
    packageRecord.frameRate,
    packageRecord.scenes,
    stopAtScene,
  ])

  if (!packageRecord.videoBlob) {
    return (
      <div className="map-empty">
        <div className="empty-map-icon" aria-hidden="true">×</div>
        <h2>Video data is missing</h2>
        <p>This saved package cannot be played because its video data is missing.</p>
      </div>
    )
  }
  if (!videoUrl) {
    return (
      <div className="map-empty">
        <span className="spinner" aria-hidden="true" />
        <h2>Preparing saved video…</h2>
        <p>The local video data is being prepared for playback.</p>
      </div>
    )
  }

  const popup = navigationTargetIndex === undefined ? activeScene?.popup : undefined
  const popupLayout = popup ? getPopupCardStyle(popup, contentRect) : undefined
  const navigationTarget = navigationTargetIndex === undefined
    ? undefined
    : packageRecord.scenes[navigationTargetIndex]
  const sceneSummary = navigationTarget
    ? `Moving to view ${navigationTarget.index + 1}: ${navigationTarget.name}`
    : activeScene
      ? `View ${activeScene.index + 1} of ${packageRecord.scenes.length}: ${activeScene.name}`
    : `Ready to jump to any of ${packageRecord.scenes.length} saved views.`

  return (
    <div className="offline-video-player">
      <div className="offline-video-stage" ref={stageRef}>
        <video
          ref={videoRef}
          controls
          playsInline
          src={videoUrl}
          aria-label={`${packageRecord.item.title} offline video`}
          onError={() => onError('The saved offline video could not be played.')}
          onEnded={(event) => {
            const targetScene = navigationTargetIndex === undefined
              ? undefined
              : packageRecord.scenes[navigationTargetIndex]
            if (targetScene) {
              stopAtScene(event.currentTarget, targetScene)
            } else {
              setCurrentTimeMs(packageRecord.durationMs)
            }
          }}
          onSeeked={(event) => setCurrentTimeMs(event.currentTarget.currentTime * 1_000)}
          onTimeUpdate={(event) => handleTimeUpdate(event.currentTarget)}
        >
          <track kind="captions" />
        </video>
        {popup && popupLayout && (
          <div className="video-popup-anchor" style={popupLayout.anchorStyle}>
            <span className="video-popup-pin" aria-hidden="true" />
            <VideoPopup popup={popup} assetUrls={assetUrls} cardStyle={popupLayout.cardStyle} />
          </div>
        )}
      </div>

      <div className="video-scene-status" role="status" aria-live="polite">
        <strong>{sceneSummary}</strong>
        <span>{formatBytes(packageRecord.byteSize)} package</span>
      </div>
      <nav className="video-scene-navigation" aria-label="Captured views">
        <button
          type="button"
          className="button button-secondary button-small"
          disabled={navigationTargetIndex !== undefined || displayedSceneIndex <= 0}
          onClick={() => navigateToScene(
            packageRecord.scenes[Math.max(0, displayedSceneIndex - 1)],
          )}
          aria-label="Go to the previous captured view"
        >
          Previous view
        </button>
        <div className="video-scene-list">
          {packageRecord.scenes.map((scene) => (
            <button
              key={scene.id}
              type="button"
              className={scene.index === displayedSceneIndex ? 'is-active' : undefined}
              aria-current={scene.index === displayedSceneIndex ? 'true' : undefined}
              aria-label={`Go to view ${scene.index + 1}: ${scene.name}`}
              disabled={navigationTargetIndex !== undefined}
              onClick={() => navigateToScene(scene)}
            >
              {scene.index + 1}. {scene.name}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="button button-secondary button-small"
          disabled={
            navigationTargetIndex !== undefined
            || displayedSceneIndex >= packageRecord.scenes.length - 1
          }
          onClick={() => navigateToScene(
            packageRecord.scenes[
              Math.min(packageRecord.scenes.length - 1, displayedSceneIndex + 1)
            ],
          )}
          aria-label="Go to the next captured view"
        >
          Next view
        </button>
      </nav>
    </div>
  )
}
