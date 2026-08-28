import { formatBytes } from '../../../shared/format.ts'
import { useObjectUrl } from '../../../shared/use-object-url.ts'
import { estimateVideoCapture } from '../capture/timeline.ts'
import type { VideoCaptureProgress, VideoDraftView } from '../types.ts'

interface VideoComposerPanelProps {
  isCapturing: boolean
  isRecordingView: boolean
  isReady: boolean
  onAdd: () => void
  onCancel: () => void
  onCapture: () => void
  onMove: (viewId: string, direction: -1 | 1) => void
  onRemove: (viewId: string) => void
  onRename: (viewId: string, name: string) => void
  onUpdate: (viewId: string) => void
  progress?: VideoCaptureProgress
  totalWarningCount?: number
  views: VideoDraftView[]
  warningCountByView?: Record<string, number>
}

function DraftViewRow({
  isBusy,
  isReady,
  index,
  onMove,
  onRemove,
  onRename,
  onUpdate,
  view,
  viewCount,
  warningCount,
}: {
  isBusy: boolean
  isReady: boolean
  index: number
  onMove: VideoComposerPanelProps['onMove']
  onRemove: VideoComposerPanelProps['onRemove']
  onRename: VideoComposerPanelProps['onRename']
  onUpdate: VideoComposerPanelProps['onUpdate']
  view: VideoDraftView
  viewCount: number
  warningCount: number
}) {
  const thumbnailUrl = useObjectUrl(view.thumbnailBlob)
  const summaryParts = [
    `${view.layers.filter((layer) => layer.visible).length} visible layers`,
    view.popup ? 'popup saved' : undefined,
    warningCount > 0 ? `${warningCount} capture warning${warningCount === 1 ? '' : 's'}` : undefined,
  ].filter(Boolean)

  return (
    <li className="video-draft-row">
      {thumbnailUrl && <img src={thumbnailUrl} alt="" />}
      <div className="video-draft-copy">
        <div className="video-draft-heading">
          <span className="video-draft-position">View {index + 1}</span>
          {warningCount > 0 && (
            <span className="video-draft-warning-badge">
              {warningCount} warning{warningCount === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <label className="video-draft-name">
          <span className="visually-hidden">View {index + 1} name</span>
          <input
            value={view.name}
            maxLength={80}
            placeholder={`View ${index + 1}`}
            disabled={isBusy}
            onChange={(event) => onRename(view.id, event.target.value)}
          />
        </label>
        <p>{summaryParts.join(' · ')}</p>
        <div
          className="video-draft-actions"
          role="group"
          aria-label={`Actions for view ${index + 1}`}
        >
          <button
            type="button"
            className="button button-small button-secondary"
            disabled={isBusy || index === 0}
            onClick={() => onMove(view.id, -1)}
            aria-label={`Move view ${index + 1} earlier`}
          >
            Earlier
          </button>
          <button
            type="button"
            className="button button-small button-secondary"
            disabled={isBusy || index === viewCount - 1}
            onClick={() => onMove(view.id, 1)}
            aria-label={`Move view ${index + 1} later`}
          >
            Later
          </button>
          <button
            type="button"
            className="button button-small button-secondary"
            disabled={isBusy || !isReady}
            onClick={() => onUpdate(view.id)}
          >
            Update
          </button>
          <button
            type="button"
            className="button button-small button-danger"
            disabled={isBusy}
            onClick={() => onRemove(view.id)}
          >
            Remove
          </button>
        </div>
      </div>
    </li>
  )
}

export function VideoComposerPanel({
  isCapturing,
  isRecordingView,
  isReady,
  onAdd,
  onCancel,
  onCapture,
  onMove,
  onRemove,
  onRename,
  onUpdate,
  progress,
  totalWarningCount = 0,
  views,
  warningCountByView = {},
}: VideoComposerPanelProps) {
  const estimate = estimateVideoCapture(views)
  const isLarge = (estimate?.workingBytes ?? 0) >= 250 * 1024 * 1024
  const isBusy = isCapturing || isRecordingView

  return (
    <section className="video-composer" aria-labelledby="video-composer-heading">
      <div className="section-heading">
        <h2 id="video-composer-heading">Compose final views</h2>
        <span className="count-badge">{views.length}</span>
      </div>
      <p className="scope-copy">
        Pan, zoom, toggle layers, and optionally open a popup. Transitions pan first, then
        animate the zoom and cross-fade the layer state separately. Add each final view in
        playback order.
      </p>
      <button
        type="button"
        className="button button-wide"
        disabled={isBusy || !isReady}
        onClick={onAdd}
      >
        {isRecordingView ? 'Saving current view…' : 'Add current view'}
      </button>

      {views.length > 0 && (
        <ol className="video-draft-list">
          {views.map((view, index) => (
            <DraftViewRow
              key={view.id}
              isBusy={isBusy}
              isReady={isReady}
              index={index}
              onMove={onMove}
              onRemove={onRemove}
              onRename={onRename}
              onUpdate={onUpdate}
              view={view}
              viewCount={views.length}
              warningCount={warningCountByView[view.id] ?? 0}
            />
          ))}
        </ol>
      )}

      {estimate && (
        <dl className="video-estimate">
          <div>
            <dt>Estimated duration</dt>
            <dd>{(estimate.durationMs / 1_000).toFixed(1)} sec</dd>
          </div>
          <div>
            <dt>Frames</dt>
            <dd>{estimate.frameCount.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Working storage</dt>
            <dd>{formatBytes(estimate.workingBytes)}</dd>
          </div>
        </dl>
      )}
      {isLarge && (
        <p className="warning-text" role="status">
          This composition may require substantial temporary storage. Remove views or reduce map
          viewport size if capture fails.
        </p>
      )}
      {totalWarningCount > 0 && (
        <p className="warning-text" role="status">
          {totalWarningCount} draft capture warning{totalWarningCount === 1 ? '' : 's'} will be
          saved with this video.
        </p>
      )}

      {progress && (
        <div className="progress-block" role="status" aria-live="polite">
          <div className="progress-copy">
            <strong>{progress.phase}</strong>
            <span>{progress.completed} / {progress.total}</span>
          </div>
          <progress
            aria-label="Offline video capture progress"
            aria-valuetext={`${progress.phase}: ${progress.completed} of ${progress.total}. ${progress.detail}`}
            value={progress.completed}
            max={Math.max(1, progress.total)}
          />
          <p>{progress.detail}</p>
        </div>
      )}

      <div className="panel-actions">
        {isCapturing ? (
          <button type="button" className="button button-danger" onClick={onCancel}>
            Cancel video capture
          </button>
        ) : (
          <button
            type="button"
            className="button"
            disabled={views.length === 0 || !isReady}
            onClick={onCapture}
          >
            Create offline video
          </button>
        )}
      </div>
    </section>
  )
}
