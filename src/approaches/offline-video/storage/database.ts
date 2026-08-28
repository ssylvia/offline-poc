import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import {
  deletePackageDirectory,
  deletePackageEntry,
  readPackageFile,
  writePackageFile,
  type DirectoryPayloadStorage,
} from '../../../shared/storage/directory.ts'
import {
  queueDirectoryCleanup,
  retryDirectoryCleanup,
} from '../../../shared/storage/directory-cleanup.ts'
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
  if (
    packageRecord.payloadStorage?.kind === 'directory'
    && packageRecord.videoFilePath
  ) {
    const file = await readPackageFile(
      packageRecord.payloadStorage,
      packageRecord.videoFilePath,
    )
    return {
      ...packageRecord,
      videoBlob: file.type
        ? file
        : new Blob([file], { type: packageRecord.videoMimeType || 'video/webm' }),
    }
  }
  return packageRecord
}

export async function putPackage(packageRecord: SavedVideoPackage): Promise<void> {
  const database = await getDatabase()
  await database.put('packages', packageRecord)
}

export async function putAsset(
  asset: VideoPackageAsset,
  storage?: DirectoryPayloadStorage,
): Promise<void> {
  const database = await getDatabase()
  if (!storage) {
    await database.put('assets', asset)
    return
  }
  const payloadPath = `assets/${encodeURIComponent(asset.assetId)}`
  await writePackageFile(storage, payloadPath, asset.blob)
  await database.put('assets', {
    ...asset,
    blob: new Blob(),
    payloadPath,
  })
}

export async function listAssets(packageId: string): Promise<VideoPackageAsset[]> {
  const database = await getDatabase()
  const assets = await database.getAllFromIndex('assets', 'by-package', packageId)
  const packageRecord = await database.get('packages', packageId)
  const directoryStorage = packageRecord?.payloadStorage?.kind === 'directory'
    ? packageRecord.payloadStorage
    : undefined
  const hydrated = directoryStorage
    ? await Promise.all(assets.map(async (asset) => (
        asset.payloadPath
          ? {
              ...asset,
              blob: await readPackageFile(directoryStorage, asset.payloadPath),
            }
          : asset
      )))
    : assets
  return hydrated.sort((left, right) => left.assetId.localeCompare(right.assetId))
}

export async function deleteAsset(packageId: string, assetId: string): Promise<void> {
  const database = await getDatabase()
  await database.delete('assets', [packageId, assetId])
}

export async function putFrame(
  frame: VideoCaptureFrame,
  storage?: DirectoryPayloadStorage,
): Promise<void> {
  const database = await getDatabase()
  if (!storage) {
    await database.put('temporaryFrames', frame)
    return
  }
  const payloadPath = `frames/${encodeURIComponent(frame.frameId)}.png`
  await writePackageFile(storage, payloadPath, frame.blob)
  await database.put('temporaryFrames', {
    ...frame,
    blob: new Blob(),
    payloadPath,
  })
}

export async function listFrames(packageId: string): Promise<VideoCaptureFrame[]> {
  const database = await getDatabase()
  const frames = await database.getAllFromIndex(
    'temporaryFrames',
    'by-package-index',
    IDBKeyRange.bound(
      [packageId, Number.MIN_SAFE_INTEGER],
      [packageId, Number.MAX_SAFE_INTEGER],
    ),
  )
  const packageRecord = await database.get('packages', packageId)
  const directoryStorage = packageRecord?.payloadStorage?.kind === 'directory'
    ? packageRecord.payloadStorage
    : undefined
  return directoryStorage
    ? Promise.all(frames.map(async (frame) => (
        frame.payloadPath
          ? {
              ...frame,
              blob: await readPackageFile(directoryStorage, frame.payloadPath),
            }
          : frame
      )))
    : frames
}

export async function getFrame(
  packageId: string,
  index: number,
): Promise<VideoCaptureFrame | undefined> {
  const database = await getDatabase()
  const frame = await database.getFromIndex(
    'temporaryFrames',
    'by-package-index',
    [packageId, index],
  )
  if (!frame?.payloadPath) {
    return frame
  }
  const packageRecord = await database.get('packages', packageId)
  if (packageRecord?.payloadStorage?.kind !== 'directory') {
    throw new Error(`Temporary frame ${index + 1} has no folder-backed package reference.`)
  }
  return {
    ...frame,
    blob: await readPackageFile(packageRecord.payloadStorage, frame.payloadPath),
  }
}

export async function getFrameById(
  packageId: string,
  frameId: string,
): Promise<VideoCaptureFrame | undefined> {
  const database = await getDatabase()
  const frame = await database.get('temporaryFrames', [packageId, frameId])
  if (!frame?.payloadPath) {
    return frame
  }
  const packageRecord = await database.get('packages', packageId)
  if (packageRecord?.payloadStorage?.kind !== 'directory') {
    throw new Error(`Temporary frame ${frameId} has no folder-backed package reference.`)
  }
  return {
    ...frame,
    blob: await readPackageFile(packageRecord.payloadStorage, frame.payloadPath),
  }
}

export async function deleteFrame(packageId: string, frameId: string): Promise<void> {
  const database = await getDatabase()
  const frame = await database.get('temporaryFrames', [packageId, frameId])
  if (frame?.payloadPath) {
    const packageRecord = await database.get('packages', packageId)
    if (packageRecord?.payloadStorage?.kind === 'directory') {
      await deletePackageEntry(packageRecord.payloadStorage, frame.payloadPath)
    }
  }
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
  if (packageRecord.payloadStorage?.kind === 'directory') {
    await deletePackageEntry(packageRecord.payloadStorage, 'frames', true)
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

async function deletePackageRecords(packageId: string): Promise<void> {
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

export async function deletePackage(packageId: string): Promise<void> {
  const database = await getDatabase()
  const packageRecord = await database.get('packages', packageId)
  if (packageRecord?.payloadStorage?.kind === 'directory') {
    await deletePackageDirectory(packageRecord.payloadStorage)
  }
  await deletePackageRecords(packageId)
}

export async function removeStaleStagingPackages(options?: {
  maxAgeMs?: number
  now?: number
}): Promise<void> {
  const database = await getDatabase()
  await retryDirectoryCleanup('offline-video')
  const now = options?.now ?? Date.now()
  const staleBefore = now - (options?.maxAgeMs ?? DEFAULT_STALE_STAGING_MAX_AGE_MS)
  const stagingPackages = await database.getAllFromIndex('packages', 'by-state', 'staging')

  for (const packageRecord of stagingPackages) {
    if (packageRecord.createdAt <= staleBefore) {
      try {
        await deletePackage(packageRecord.packageId)
      } catch (error) {
        if (packageRecord.payloadStorage?.kind !== 'directory') {
          throw error
        }
        console.warn(
          `Stale video package ${packageRecord.packageId} could not be removed from its folder; browser metadata will still be cleaned up.`,
          error,
        )
        await queueDirectoryCleanup(packageRecord.packageId, packageRecord.payloadStorage)
        await deletePackageRecords(packageRecord.packageId)
      }
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
