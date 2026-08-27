import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import {
  deletePackageDirectory,
  readPackageJson,
  writePackageJson,
  type DirectoryPayloadStorage,
} from '../../../shared/storage/directory.ts'
import {
  queueDirectoryCleanup,
  retryDirectoryCleanup,
} from '../../../shared/storage/directory-cleanup.ts'
import type {
  FeatureChunk,
  FeatureLayerSnapshot,
  SavedMapPackage,
} from '../types.ts'

interface OfflineWebMapDatabase extends DBSchema {
  featureChunks: {
    key: string
    value: FeatureChunk
    indexes: {
      'by-layer': [string, string]
      'by-package': string
    }
  }
  layerSnapshots: {
    key: [string, string]
    value: FeatureLayerSnapshot
    indexes: {
      'by-package': string
    }
  }
  packages: {
    key: string
    value: SavedMapPackage
    indexes: {
      'by-item': string
      'by-state': string
    }
  }
}

let databasePromise: Promise<IDBPDatabase<OfflineWebMapDatabase>> | undefined

function getDatabase(): Promise<IDBPDatabase<OfflineWebMapDatabase>> {
  databasePromise ??= openDB<OfflineWebMapDatabase>('offline-arcgis-webmaps', 1, {
    upgrade(database) {
      const packages = database.createObjectStore('packages', { keyPath: 'packageId' })
      packages.createIndex('by-item', 'item.id')
      packages.createIndex('by-state', 'state')

      const layers = database.createObjectStore('layerSnapshots', {
        keyPath: ['packageId', 'layerId'],
      })
      layers.createIndex('by-package', 'packageId')

      const chunks = database.createObjectStore('featureChunks', { keyPath: 'chunkId' })
      chunks.createIndex('by-layer', ['packageId', 'layerId'])
      chunks.createIndex('by-package', 'packageId')
    },
  })

  return databasePromise
}

export async function listSavedPackages(): Promise<SavedMapPackage[]> {
  const database = await getDatabase()
  const packages = await database.getAllFromIndex('packages', 'by-state', 'complete')
  return packages.sort((left, right) => (right.completedAt ?? 0) - (left.completedAt ?? 0))
}

export async function getSavedPackage(itemId: string): Promise<SavedMapPackage | undefined> {
  const database = await getDatabase()
  const packages = await database.getAllFromIndex('packages', 'by-item', itemId)
  return packages
    .filter((entry) => entry.state === 'complete')
    .sort((left, right) => (right.completedAt ?? 0) - (left.completedAt ?? 0))[0]
}

export async function putPackage(packageRecord: SavedMapPackage): Promise<void> {
  const database = await getDatabase()
  await database.put('packages', packageRecord)
}

export async function putLayerSnapshot(snapshot: FeatureLayerSnapshot): Promise<void> {
  const database = await getDatabase()
  await database.put('layerSnapshots', snapshot)
}

export async function putFeatureChunk(
  chunk: FeatureChunk,
  storage?: DirectoryPayloadStorage,
): Promise<void> {
  const database = await getDatabase()
  if (!storage) {
    await database.put('featureChunks', chunk)
    return
  }
  const payloadPath = `features/${encodeURIComponent(chunk.layerId)}/${chunk.index}.json`
  await writePackageJson(storage, payloadPath, chunk.features)
  await database.put('featureChunks', {
    ...chunk,
    features: [],
    payloadPath,
  })
}

export async function getLayerSnapshots(packageId: string): Promise<FeatureLayerSnapshot[]> {
  const database = await getDatabase()
  return database.getAllFromIndex('layerSnapshots', 'by-package', packageId)
}

export async function getFeatureChunks(
  packageId: string,
  layerId: string,
): Promise<FeatureChunk[]> {
  const database = await getDatabase()
  const chunks = await database.getAllFromIndex(
    'featureChunks',
    'by-layer',
    IDBKeyRange.only([packageId, layerId]),
  )
  const packageRecord = await database.get('packages', packageId)
  const directoryStorage = packageRecord?.payloadStorage?.kind === 'directory'
    ? packageRecord.payloadStorage
    : undefined
  const hydrated = directoryStorage
    ? await Promise.all(chunks.map(async (chunk) => (
        chunk.payloadPath
          ? {
              ...chunk,
              features: await readPackageJson<FeatureChunk['features']>(
                directoryStorage,
                chunk.payloadPath,
              ),
            }
          : chunk
      )))
    : chunks
  return hydrated.sort((left, right) => left.index - right.index)
}

export async function finalizePackage(
  packageRecord: SavedMapPackage,
): Promise<SavedMapPackage> {
  const database = await getDatabase()
  const previousPackages = (await database.getAllFromIndex(
    'packages',
    'by-item',
    packageRecord.item.id,
  )).filter((entry) => entry.state === 'complete' && entry.packageId !== packageRecord.packageId)

  const completedPackage: SavedMapPackage = {
    ...packageRecord,
    completedAt: Date.now(),
    state: 'complete',
  }
  await database.put('packages', completedPackage)

  for (const previousPackage of previousPackages) {
    await deletePackage(previousPackage)
  }

  return completedPackage
}

async function deletePackageRecords(packageRecord: SavedMapPackage): Promise<void> {
  const database = await getDatabase()
  const transaction = database.transaction(
    ['packages', 'layerSnapshots', 'featureChunks'],
    'readwrite',
  )
  await transaction.objectStore('packages').delete(packageRecord.packageId)

  let layerCursor = await transaction
    .objectStore('layerSnapshots')
    .index('by-package')
    .openCursor(IDBKeyRange.only(packageRecord.packageId))
  while (layerCursor) {
    await layerCursor.delete()
    layerCursor = await layerCursor.continue()
  }

  let chunkCursor = await transaction
    .objectStore('featureChunks')
    .index('by-package')
    .openCursor(IDBKeyRange.only(packageRecord.packageId))
  while (chunkCursor) {
    await chunkCursor.delete()
    chunkCursor = await chunkCursor.continue()
  }

  await transaction.done
  await caches.delete(packageRecord.cacheName)
}

export async function deletePackage(packageRecord: SavedMapPackage): Promise<void> {
  if (packageRecord.payloadStorage?.kind === 'directory') {
    await deletePackageDirectory(packageRecord.payloadStorage)
  }
  await deletePackageRecords(packageRecord)
}

export async function removeStaleStagingPackages(): Promise<void> {
  const database = await getDatabase()
  await retryDirectoryCleanup('interactive-map')
  const stagingPackages = await database.getAllFromIndex('packages', 'by-state', 'staging')
  for (const packageRecord of stagingPackages) {
    try {
      await deletePackage(packageRecord)
    } catch (error) {
      if (packageRecord.payloadStorage?.kind !== 'directory') {
        throw error
      }
      console.warn(
        `Stale map package ${packageRecord.packageId} could not be removed from its folder; browser metadata will still be cleaned up.`,
        error,
      )
      await queueDirectoryCleanup(packageRecord.packageId, packageRecord.payloadStorage)
      await deletePackageRecords(packageRecord)
    }
  }

  const remainingPackages = await database.getAll('packages')
  const packageIds = new Set(remainingPackages.map((entry) => entry.packageId))
  const cacheNames = new Set(remainingPackages.map((entry) => entry.cacheName))
  const transaction = database.transaction(['layerSnapshots', 'featureChunks'], 'readwrite')

  let layerCursor = await transaction.objectStore('layerSnapshots').openCursor()
  while (layerCursor) {
    if (!packageIds.has(layerCursor.value.packageId)) {
      await layerCursor.delete()
    }
    layerCursor = await layerCursor.continue()
  }

  let chunkCursor = await transaction.objectStore('featureChunks').openCursor()
  while (chunkCursor) {
    if (!packageIds.has(chunkCursor.value.packageId)) {
      await chunkCursor.delete()
    }
    chunkCursor = await chunkCursor.continue()
  }
  await transaction.done

  for (const cacheName of await caches.keys()) {
    if (cacheName.startsWith('offline-webmap-') && !cacheNames.has(cacheName)) {
      await caches.delete(cacheName)
    }
  }
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
