import { formatBytes } from '../../../shared/format.ts'
import type {
  DownloadProgress,
  PreflightReport,
} from '../types.ts'

interface DownloadPanelProps {
  allowDegraded: boolean
  isDownloading: boolean
  onAllowDegradedChange: (value: boolean) => void
  onCancel: () => void
  onClose: () => void
  onDownload: () => void
  persistentStorage?: boolean
  progress?: DownloadProgress
  report: PreflightReport
  storageEstimate: StorageEstimate
}

export function DownloadPanel({
  allowDegraded,
  isDownloading,
  onAllowDegradedChange,
  onCancel,
  onClose,
  onDownload,
  persistentStorage,
  progress,
  report,
  storageEstimate,
}: DownloadPanelProps) {
  const freeBytes = storageEstimate.quota !== undefined
    ? storageEstimate.quota - (storageEstimate.usage ?? 0)
    : undefined
  const exceedsQuota = freeBytes !== undefined && report.estimatedBytes > freeBytes
  const percent = progress && progress.total > 0
    ? Math.round(progress.completed / progress.total * 100)
    : 0

  return (
    <section className="download-panel" aria-labelledby="download-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Download preflight</p>
          <h2 id="download-heading">Offline snapshot</h2>
        </div>
        {!isDownloading && (
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close preflight">
            ×
          </button>
        )}
      </div>

      <dl className="preflight-facts">
        <div>
          <dt>Estimated size</dt>
          <dd>{formatBytes(report.estimatedBytes)}</dd>
        </div>
        <div>
          <dt>Resources</dt>
          <dd>{report.resourceUrls.length.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Feature records</dt>
          <dd>
            {report.featurePlans
              .reduce((total, plan) => total + plan.featureCount, 0)
              .toLocaleString()}
          </dd>
        </div>
        <div>
          <dt>Tile levels</dt>
          <dd>{report.levels.length > 0 ? report.levels.join(', ') : 'Feature-only'}</dd>
        </div>
      </dl>

      <p className="scope-copy">
        Coverage uses the current view plus a 25% buffer and up to two higher-detail levels.
      </p>

      {freeBytes !== undefined && (
        <p className={exceedsQuota ? 'error-text' : 'muted-copy'}>
          Browser storage available: {formatBytes(freeBytes)}
        </p>
      )}
      {persistentStorage !== undefined && (
        <p className={persistentStorage ? 'success-text' : 'warning-text'}>
          {persistentStorage
            ? 'The browser granted persistent storage.'
            : 'Persistent storage was not granted; the browser may evict this snapshot.'}
        </p>
      )}

      <div className="compatibility-list" aria-label="Layer compatibility">
        {report.layerResults.map((result) => (
          <div className={`compatibility-row compatibility-${result.level}`} key={result.id}>
            <span className="status-dot" aria-hidden="true" />
            <div>
              <strong>{result.title}</strong>
              <span>{result.type}</span>
              <p>{result.message}</p>
            </div>
          </div>
        ))}
      </div>

      {report.hasLimitations && !isDownloading && (
        <label className="approval-check">
          <input
            type="checkbox"
            checked={allowDegraded}
            onChange={(event) => onAllowDegradedChange(event.target.checked)}
          />
          <span>
            Create a partial snapshot and omit or degrade the clearly listed unsupported content.
          </span>
        </label>
      )}

      {isDownloading && progress && (
        <div className="progress-block" aria-live="polite">
          <div className="progress-copy">
            <strong>{progress.phase}</strong>
            <span>{percent}%</span>
          </div>
          <progress max={progress.total || 1} value={progress.completed} />
          <p>{progress.detail}</p>
        </div>
      )}

      <div className="panel-actions">
        {isDownloading
          ? (
            <button type="button" className="button button-danger" onClick={onCancel}>
              Cancel download
            </button>
          )
          : (
            <button
              type="button"
              className="button"
              disabled={exceedsQuota || (report.hasLimitations && !allowDegraded)}
              onClick={onDownload}
            >
              Download for offline use
            </button>
          )}
      </div>

      <p className="legal-copy">
        This prototype stores browser-managed snapshots. Keep Esri and source attribution visible,
        and confirm that each content provider permits offline retention.
      </p>
    </section>
  )
}
