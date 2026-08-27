import { formatBytes, formatDate } from '../../../shared/format.ts'
import { useObjectUrl } from '../../../shared/use-object-url.ts'
import type { SavedMapPackage } from '../types.ts'

interface SavedMapLibraryProps {
  onDelete: (packageRecord: SavedMapPackage) => void
  onOpen: (packageRecord: SavedMapPackage) => void
  onUpdate: (packageRecord: SavedMapPackage) => void
  packages: SavedMapPackage[]
}

function SavedMapCard({
  onDelete,
  onOpen,
  onUpdate,
  packageRecord,
}: Omit<SavedMapLibraryProps, 'packages'> & { packageRecord: SavedMapPackage }) {
  const thumbnailUrl = useObjectUrl(packageRecord.thumbnailBlob)

  const limitationCount = packageRecord.compatibility.filter(
    (result) => result.level !== 'supported',
  ).length

  return (
    <article className="saved-map-card">
      <div className="saved-map-thumbnail" aria-hidden="true">
        {thumbnailUrl
          ? <img src={thumbnailUrl} alt="" />
          : <span>MAP</span>}
      </div>
      <div className="saved-map-copy">
        <h3>{packageRecord.item.title}</h3>
        <p className="item-id">{packageRecord.item.id}</p>
        <p>
          {formatBytes(packageRecord.byteSize)}
          {' · '}
          {packageRecord.featureCount.toLocaleString()} features
        </p>
        <p>Saved {formatDate(packageRecord.completedAt ?? packageRecord.createdAt)}</p>
        {limitationCount > 0 && (
          <p className="warning-text">{limitationCount} known offline limitation(s)</p>
        )}
        <div className="card-actions">
          <button type="button" className="button button-small" onClick={() => onOpen(packageRecord)}>
            Open offline
          </button>
          <button
            type="button"
            className="button button-small button-secondary"
            onClick={() => onUpdate(packageRecord)}
          >
            Update
          </button>
          <button
            type="button"
            className="button button-small button-danger"
            onClick={() => onDelete(packageRecord)}
          >
            Delete
          </button>
        </div>
      </div>
    </article>
  )
}

export function SavedMapLibrary({
  onDelete,
  onOpen,
  onUpdate,
  packages,
}: SavedMapLibraryProps) {
  return (
    <section className="saved-library" aria-labelledby="saved-map-heading">
      <div className="section-heading">
        <h2 id="saved-map-heading">Saved maps</h2>
        <span className="count-badge">{packages.length}</span>
      </div>
      {packages.length === 0
        ? (
          <p className="empty-copy">
            No maps are available offline yet. Load a public WebMap while online to create one.
          </p>
        )
        : packages.map((packageRecord) => (
          <SavedMapCard
            key={packageRecord.packageId}
            packageRecord={packageRecord}
            onDelete={onDelete}
            onOpen={onOpen}
            onUpdate={onUpdate}
          />
        ))}
    </section>
  )
}
