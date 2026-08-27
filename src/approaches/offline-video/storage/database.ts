import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type {
  SavedVideoPackage,
  VideoCaptureFrame,
  VideoPackageAsset,
  VideoPackageState,
} from '../types.ts'

export const VIDEO_STORAGE_DATABASE_NAME = 'offline-video-packages'
export const DEFAULT_STALE_STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1_000

interface OfflineVideoDatabase extends DBSchema {
  assets: {
    key: [string, string]
    value: VideoPackageAsset
    indexes: {
      'by-package': string
    }
  }
  packages: {
    key: string
    value: SavedVideoPackage
    indexes: {
      'by-item': string
      'by-item-state': [string, VideoPackageState]
      'by-state': VideoPackageState
    }
  }
  temporaryFrames: {
    key: [string, string]
    value: VideoCaptureFrame
    indexes: {
      'by-package': string
      'by-package-index': [string, number]
    }
  }
}

let databasePromise: Promise<IDBPDatabase<OfflineVideoDatabase>> | undefined

function getDatabase(): Promise<IDBPDatabase<OfflineVideoDatabase>> {
  databasePromise ??= openDB<OfflineVideoDatabase>(VIDEO_STORAGE_DATABASE_NAME, 1, {
    upgrade(database) {
      const packages = database.createObjectStore('packages', { keyPath: 'packageId' })
      packages.createIndex('by-item', 'item.id')
      packages.createIndex('by-item-state', ['item.id', 'state'])
      packages.createIndex('by-state', 'state')

      const assets = database.createObjectStore('assets', {
        keyPath: ['packageId', 'assetId'],
      })
      assets.createIndex('by-package', 'packageId')

      const temporaryFrames = database.createObjectStore('temporaryFrames', {
        keyPath: ['packageId', 'frameId'],
      })
      temporaryFrames.createIndex('by-package', 'packageId')
      temporaryFrames.createIndex('by-package-index', ['packageId', 'index'])
    },
  })

  return databasePromise
}

function sortSavedPackages(packages: SavedVideoPackage[]): SavedVideoPackage[] {
  return packages.sort((left, right) => {
    const completedDelta = (right.completedAt ?? 0) - (left.completedAt ?? 0)
    if (completedDelta !== 0) {
      return completedDelta
    }
    return right.createdAt - left.createdAt
  })
}

export async function listSavedPackages(itemId?: string): Promise<SavedVideoPackage[]> {
  const database = await getDatabase()
  const packages = itemId === undefined
    ? await database.getAllFromIndex('packages', 'by-state', 'complete')
    : await database.getAllFromIndex('packages', 'by-item-state', [itemId, 'complete'])
  return sortSavedPackages(packages)
}

export async function getSavedPackage(
  packageId: string,
): Promise<SavedVideoPackage | undefined> {
  const database = await getDatabase()
  const packageRecord = await database.get('packages', packageId)
  if (packageRecord?.state !== 'complete') {
    return undefined
  }
  return packageRecord
}

export async function putPackage(packageRecord: SavedVideoPackage): Promise<void> {
  const database = await getDatabase()
  await database.put('packages', packageRecord)
}

export async function putAsset(asset: VideoPackageAsset): Promise<void> {
  const database = await getDatabase()
  await database.put('assets', asset)
}

export async function listAssets(packageId: string): Promise<VideoPackageAsset[]> {
  const database = await getDatabase()
  const assets = await database.getAllFromIndex('assets', 'by-package', packageId)
  return assets.sort((left, right) => left.assetId.localeCompare(right.assetId))
}

export async function deleteAsset(packageId: string, assetId: string): Promise<void> {
  const database = await getDatabase()
  await database.delete('assets', [packageId, assetId])
}

export async function putFrame(frame: VideoCaptureFrame): Promise<void> {
  const database = await getDatabase()
  await database.put('temporaryFrames', frame)
}

export async function listFrames(packageId: string): Promise<VideoCaptureFrame[]> {
  const database = await getDatabase()
  return database.getAllFromIndex(
    'temporaryFrames',
    'by-package-index',
    IDBKeyRange.bound(
      [packageId, Number.MIN_SAFE_INTEGER],
      [packageId, Number.MAX_SAFE_INTEGER],
    ),
  )
}

export async function getFrame(
  packageId: string,
  index: number,
): Promise<VideoCaptureFrame | undefined> {
  const database = await getDatabase()
  return database.getFromIndex('temporaryFrames', 'by-package-index', [packageId, index])
}

export async function deleteFrame(packageId: string, frameId: string): Promise<void> {
  const database = await getDatabase()
  await database.delete('temporaryFrames', [packageId, frameId])
}

export async function finalizePackage(
  packageRecord: SavedVideoPackage,
): Promise<SavedVideoPackage> {
  const database = await getDatabase()
  const completedPackage: SavedVideoPackage = {
    ...packageRecord,
    completedAt: Date.now(),
    state: 'complete',
  }
  const transaction = database.transaction(['packages', 'temporaryFrames'], 'readwrite')

  await transaction.objectStore('packages').put(completedPackage)

  let frameCursor = await transaction
    .objectStore('temporaryFrames')
    .index('by-package')
    .openCursor(IDBKeyRange.only(packageRecord.packageId))
  while (frameCursor) {
    await frameCursor.delete()
    frameCursor = await frameCursor.continue()
  }

  await transaction.done
  return completedPackage
}

export async function deletePackage(packageId: string): Promise<void> {
  const database = await getDatabase()
  const transaction = database.transaction(
    ['packages', 'assets', 'temporaryFrames'],
    'readwrite',
  )
  await transaction.objectStore('packages').delete(packageId)

  let assetCursor = await transaction
    .objectStore('assets')
    .index('by-package')
    .openCursor(IDBKeyRange.only(packageId))
  while (assetCursor) {
    await assetCursor.delete()
    assetCursor = await assetCursor.continue()
  }

  let frameCursor = await transaction
    .objectStore('temporaryFrames')
    .index('by-package')
    .openCursor(IDBKeyRange.only(packageId))
  while (frameCursor) {
    await frameCursor.delete()
    frameCursor = await frameCursor.continue()
  }

  await transaction.done
}

export async function removeStaleStagingPackages(options?: {
  maxAgeMs?: number
  now?: number
}): Promise<void> {
  const database = await getDatabase()
  const now = options?.now ?? Date.now()
  const staleBefore = now - (options?.maxAgeMs ?? DEFAULT_STALE_STAGING_MAX_AGE_MS)
  const stagingPackages = await database.getAllFromIndex('packages', 'by-state', 'staging')

  for (const packageRecord of stagingPackages) {
    if (packageRecord.createdAt <= staleBefore) {
      await deletePackage(packageRecord.packageId)
    }
  }

  const remainingPackages = await database.getAll('packages')
  const packageIds = new Set(remainingPackages.map((entry) => entry.packageId))
  const transaction = database.transaction(['assets', 'temporaryFrames'], 'readwrite')

  let assetCursor = await transaction.objectStore('assets').openCursor()
  while (assetCursor) {
    if (!packageIds.has(assetCursor.value.packageId)) {
      await assetCursor.delete()
    }
    assetCursor = await assetCursor.continue()
  }

  let frameCursor = await transaction.objectStore('temporaryFrames').openCursor()
  while (frameCursor) {
    if (!packageIds.has(frameCursor.value.packageId)) {
      await frameCursor.delete()
    }
    frameCursor = await frameCursor.continue()
  }

  await transaction.done
}

export async function getStorageEstimate(): Promise<StorageEstimate> {
  if (!navigator.storage?.estimate) {
    return {}
  }
  return navigator.storage.estimate()
}

export async function requestPersistentStorage(): Promise<boolean | undefined> {
  if (!navigator.storage?.persist) {
    return undefined
  }
  return navigator.storage.persist()
}
