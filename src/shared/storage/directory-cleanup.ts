import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import {
  deletePackageDirectory,
  type DirectoryPayloadStorage,
  type PackageKind,
} from './directory.ts'

interface PendingDirectoryCleanup {
  id: string
  packageId: string
  payloadStorage: DirectoryPayloadStorage
}

interface DirectoryCleanupDatabase extends DBSchema {
  pendingCleanup: {
    key: string
    value: PendingDirectoryCleanup
    indexes: {
      'by-package-kind': PackageKind
    }
  }
}

let databasePromise: Promise<IDBPDatabase<DirectoryCleanupDatabase>> | undefined

function getDatabase(): Promise<IDBPDatabase<DirectoryCleanupDatabase>> {
  databasePromise ??= openDB<DirectoryCleanupDatabase>('offline-package-cleanup', 1, {
    upgrade(database) {
      const cleanup = database.createObjectStore('pendingCleanup', { keyPath: 'id' })
      cleanup.createIndex('by-package-kind', 'payloadStorage.packageKind')
    },
  })
  return databasePromise
}

export async function queueDirectoryCleanup(
  packageId: string,
  payloadStorage: DirectoryPayloadStorage,
): Promise<void> {
  const database = await getDatabase()
  await database.put('pendingCleanup', {
    id: `${payloadStorage.packageKind}:${packageId}`,
    packageId,
    payloadStorage,
  })
}

export async function retryDirectoryCleanup(
  packageKind: PackageKind,
): Promise<{ pending: number; removed: number }> {
  const database = await getDatabase()
  const pendingCleanup = await database.getAllFromIndex(
    'pendingCleanup',
    'by-package-kind',
    packageKind,
  )
  let pending = 0
  let removed = 0

  for (const cleanup of pendingCleanup) {
    try {
      await deletePackageDirectory(cleanup.payloadStorage)
      await database.delete('pendingCleanup', cleanup.id)
      removed += 1
    } catch (error) {
      pending += 1
      console.warn(
        `${packageKind} package ${cleanup.packageId} is still waiting for folder cleanup.`,
        error,
      )
    }
  }
  return { pending, removed }
}
