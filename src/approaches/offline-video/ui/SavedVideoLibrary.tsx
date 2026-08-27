import { useEffect, useMemo } from 'react'
import { formatBytes, formatDate } from '../../../shared/format.ts'
import type { SavedVideoPackage } from '../types.ts'

interface SavedVideoLibraryProps {
  onDelete: (packageRecord: SavedVideoPackage) => void
  onExport: (packageRecord: SavedVideoPackage) => void
  onOpen: (packageRecord: SavedVideoPackage) => void
  onRecapture: (packageRecord: SavedVideoPackage) => void
  packages: SavedVideoPackage[]
}

function SavedVideoCard({
  onDelete,
  onExport,
  onOpen,
  onRecapture,
  packageRecord,
}: Omit<SavedVideoLibraryProps, 'packages'> & { packageRecord: SavedVideoPackage }) {
  const savedAt = formatDate(packageRecord.completedAt ?? packageRecord.createdAt)
  const thumbnailUrl = useMemo(
    () => URL.createObjectURL(packageRecord.thumbnailBlob),
    [packageRecord.thumbnailBlob],
  )
  useEffect(() => () => URL.revokeObjectURL(thumbnailUrl), [thumbnailUrl])

  return (
    <article className="saved-map-card saved-video-card">
      <div className="saved-map-thumbnail" aria-hidden="true">
        <img src={thumbnailUrl} alt="" />
        <span className="video-thumbnail-badge">VIDEO</span>
      </div>
      <div className="saved-map-copy">
        <div className="saved-video-card-heading">
          <h3>{packageRecord.item.title}</h3>
          {packageRecord.warnings.length > 0 && (
            <span className="video-draft-warning-badge">
              {packageRecord.warnings.length} warning{packageRecord.warnings.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <p className="item-id">WebMap {packageRecord.item.id}</p>
        <p className="item-id">Package {packageRecord.packageId}</p>
        <dl className="saved-video-metadata">
          <div>
            <dt>Package size</dt>
            <dd>{formatBytes(packageRecord.byteSize)}</dd>
          </div>
          <div>
            <dt>Saved views</dt>
            <dd>{packageRecord.scenes.length}</dd>
          </div>
          <div>
            <dt>Duration</dt>
            <dd>{(packageRecord.durationMs / 1_000).toFixed(1)} sec</dd>
          </div>
        </dl>
        <p>Saved {savedAt}</p>
        <div className="card-actions">
          <button
            type="button"
            className="button button-small"
            aria-label={`Open saved video package ${packageRecord.packageId} for ${packageRecord.item.title}`}
            onClick={() => onOpen(packageRecord)}
          >
            Open offline
          </button>
          <button
            type="button"
            className="button button-small button-secondary"
            aria-label={`Export saved video package ${packageRecord.packageId} for ${packageRecord.item.title}`}
            onClick={() => onExport(packageRecord)}
          >
            Export
          </button>
          <button
            type="button"
            className="button button-small button-secondary"
            aria-label={`Recapture ${packageRecord.item.title} from the live WebMap`}
            onClick={() => onRecapture(packageRecord)}
          >
            Recapture
          </button>
          <button
            type="button"
            className="button button-small button-danger"
            aria-label={`Delete saved video package ${packageRecord.packageId} for ${packageRecord.item.title}`}
            onClick={() => onDelete(packageRecord)}
          >
            Delete
          </button>
        </div>
      </div>
    </article>
  )
}

export function SavedVideoLibrary({
  onDelete,
  onExport,
  onOpen,
  onRecapture,
  packages,
}: SavedVideoLibraryProps) {
  return (
    <section className="saved-library" aria-labelledby="saved-video-heading">
      <div className="section-heading">
        <h2 id="saved-video-heading">Saved videos</h2>
        <span className="count-badge">{packages.length}</span>
      </div>
      {packages.length === 0 ? (
        <p className="empty-copy">
          No offline videos have been captured in this browser.
        </p>
      ) : packages.map((packageRecord) => (
        <SavedVideoCard
          key={packageRecord.packageId}
          onDelete={onDelete}
          onExport={onExport}
          onOpen={onOpen}
          onRecapture={onRecapture}
          packageRecord={packageRecord}
        />
      ))}
    </section>
  )
}
