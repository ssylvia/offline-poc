import type { DirectoryDestinationState } from './use-directory-destination.ts'

interface StorageDestinationPickerProps {
  disabled?: boolean
  state: DirectoryDestinationState
}

export function StorageDestinationPicker({
  disabled = false,
  state,
}: StorageDestinationPickerProps) {
  const { destination } = state
  const isGranted = destination?.permission === 'granted'

  return (
    <section className="storage-destination" aria-labelledby="storage-destination-heading">
      <div className="section-heading">
        <h2 id="storage-destination-heading">Package storage</h2>
      </div>
      {!state.isSupported && (
        <p className="muted-copy">
          This browser stores packages in browser-managed storage. Folder storage requires desktop
          Chrome or Edge.
        </p>
      )}
      {state.isSupported && !destination && (
        <>
          <p className="scope-copy">
            Browser storage is active. Choose a folder to save large package payloads directly to
            disk.
          </p>
          <button
            type="button"
            className="button button-secondary button-wide"
            disabled={disabled || state.isBusy}
            onClick={() => void state.choose()}
          >
            {state.isBusy ? 'Reading storage setting…' : 'Choose download folder'}
          </button>
        </>
      )}
      {state.isSupported && destination && (
        <>
          <p className={isGranted ? 'success-text' : 'warning-text'}>
            {isGranted
              ? `Folder storage is active: ${destination.name}`
              : `Reconnect ${destination.name} before saving or opening folder-backed packages.`}
          </p>
          <div className="storage-destination-actions">
            {!isGranted && (
              <button
                type="button"
                className="button button-secondary button-small"
                disabled={disabled || state.isBusy}
                onClick={() => void state.reconnect()}
              >
                Reconnect folder
              </button>
            )}
            <button
              type="button"
              className="button button-secondary button-small"
              disabled={disabled || state.isBusy}
              onClick={() => void state.choose()}
            >
              Change folder
            </button>
            <button
              type="button"
              className="button button-secondary button-small"
              disabled={disabled || state.isBusy}
              onClick={() => void state.clear()}
            >
              Use browser storage
            </button>
          </div>
        </>
      )}
      {state.error && <p className="error-text" role="alert">{state.error}</p>}
    </section>
  )
}
