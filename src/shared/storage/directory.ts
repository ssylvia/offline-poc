import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

const databaseName = 'offline-package-directories'
const packageRootName = 'offline-arcgis-packages'
const selectedDestinationKey = 'selected-destination'

export type PackageKind = 'interactive-map' | 'offline-video'

export interface BrowserPayloadStorage {
  kind: 'browser'
}

export interface DirectoryPayloadStorage {
  destinationId: string
  directoryName: string
  kind: 'directory'
  packageKind: PackageKind
}

export type PayloadStorageReference = BrowserPayloadStorage | DirectoryPayloadStorage

interface DirectoryDestinationRecord {
  handle: FileSystemDirectoryHandle
  id: string
  selectedAt: number
}

interface DirectorySetting {
  key: string
  value: string
}

interface DirectoryDatabase extends DBSchema {
  destinations: {
    key: string
    value: DirectoryDestinationRecord
  }
  settings: {
    key: string
    value: DirectorySetting
  }
}

export interface DirectoryDestination {
  handle: FileSystemDirectoryHandle
  id: string
  name: string
  permission: PermissionState
}

export class DirectoryAccessError extends Error {
  readonly code: 'missing' | 'permission'

  constructor(code: 'missing' | 'permission', message: string) {
    super(message)
    this.name = 'DirectoryAccessError'
    this.code = code
  }
}

let databasePromise: Promise<IDBPDatabase<DirectoryDatabase>> | undefined
const destinationHandleById = new Map<string, FileSystemDirectoryHandle>()

function getDatabase(): Promise<IDBPDatabase<DirectoryDatabase>> {
  databasePromise ??= openDB<DirectoryDatabase>(databaseName, 1, {
    upgrade(database) {
      database.createObjectStore('destinations', { keyPath: 'id' })
      database.createObjectStore('settings', { keyPath: 'key' })
    },
  })
  return databasePromise
}

export function isDirectoryStorageSupported(): boolean {
  return typeof window !== 'undefined'
    && window.isSecureContext
    && typeof window.showDirectoryPicker === 'function'
}

async function toDestination(
  record: DirectoryDestinationRecord,
): Promise<DirectoryDestination> {
  const handle = destinationHandleById.get(record.id) ?? record.handle
  destinationHandleById.set(record.id, handle)
  return {
    handle,
    id: record.id,
    name: handle.name,
    permission: await handle.queryPermission({ mode: 'readwrite' }),
  }
}

export async function getSelectedDirectory(): Promise<DirectoryDestination | undefined> {
  const database = await getDatabase()
  const selected = await database.get('settings', selectedDestinationKey)
  if (!selected) {
    return undefined
  }
  const record = await database.get('destinations', selected.value)
  return record ? toDestination(record) : undefined
}

async function findExistingDestination(
  handle: FileSystemDirectoryHandle,
): Promise<DirectoryDestinationRecord | undefined> {
  const database = await getDatabase()
  for (const record of await database.getAll('destinations')) {
    const storedHandle = destinationHandleById.get(record.id) ?? record.handle
    if (await storedHandle.isSameEntry(handle)) {
      return { ...record, handle: storedHandle }
    }
  }
  return undefined
}

export async function chooseDirectory(): Promise<DirectoryDestination> {
  if (!isDirectoryStorageSupported()) {
    throw new Error('Folder-backed storage is not supported in this browser.')
  }
  const handle = await window.showDirectoryPicker({
    id: 'offline-arcgis-packages',
    mode: 'readwrite',
  })
  const permission = await handle.requestPermission({ mode: 'readwrite' })
  if (permission !== 'granted') {
    throw new DirectoryAccessError(
      'permission',
      'Read and write permission is required to use the selected folder.',
    )
  }

  const database = await getDatabase()
  const existing = await findExistingDestination(handle)
  const record: DirectoryDestinationRecord = existing ?? {
    handle,
    id: crypto.randomUUID(),
    selectedAt: Date.now(),
  }
  if (existing) {
    record.handle = handle
    record.selectedAt = Date.now()
  }
  destinationHandleById.set(record.id, handle)
  const transaction = database.transaction(['destinations', 'settings'], 'readwrite')
  await transaction.objectStore('destinations').put(record)
  await transaction.objectStore('settings').put({
    key: selectedDestinationKey,
    value: record.id,
  })
  await transaction.done
  return toDestination(record)
}

export async function reconnectDirectory(
  destinationId: string,
): Promise<DirectoryDestination> {
  const database = await getDatabase()
  const record = await database.get('destinations', destinationId)
  if (!record) {
    throw new DirectoryAccessError(
      'missing',
      'The saved folder reference is unavailable. Choose the folder again.',
    )
  }
  const handle = destinationHandleById.get(record.id) ?? record.handle
  destinationHandleById.set(record.id, handle)
  const permission = await handle.requestPermission({ mode: 'readwrite' })
  if (permission !== 'granted') {
    throw new DirectoryAccessError(
      'permission',
      'The browser did not grant access to the selected folder.',
    )
  }
  return toDestination({ ...record, handle })
}

export async function clearSelectedDirectory(): Promise<void> {
  const database = await getDatabase()
  await database.delete('settings', selectedDestinationKey)
}

export function createDirectoryStorageReference(
  destination: DirectoryDestination,
  packageKind: PackageKind,
  directoryName: string,
): DirectoryPayloadStorage {
  if (destination.permission !== 'granted') {
    throw new DirectoryAccessError(
      'permission',
      'Reconnect the selected folder before saving this package.',
    )
  }
  return {
    destinationId: destination.id,
    directoryName,
    kind: 'directory',
    packageKind,
  }
}

async function getDestinationRecord(
  destinationId: string,
): Promise<DirectoryDestinationRecord> {
  const database = await getDatabase()
  const record = await database.get('destinations', destinationId)
  if (!record) {
    throw new DirectoryAccessError(
      'missing',
      'The folder used by this package is no longer registered. Choose it again.',
    )
  }
  const handle = destinationHandleById.get(record.id) ?? record.handle
  destinationHandleById.set(record.id, handle)
  const permission = await handle.queryPermission({ mode: 'readwrite' })
  if (permission !== 'granted') {
    throw new DirectoryAccessError(
      'permission',
      `Reconnect the “${handle.name}” folder to open this package.`,
    )
  }
  return { ...record, handle }
}

export async function getPackageDirectory(
  storage: DirectoryPayloadStorage,
  create = false,
): Promise<FileSystemDirectoryHandle> {
  const destination = await getDestinationRecord(storage.destinationId)
  const root = await destination.handle.getDirectoryHandle(packageRootName, { create })
  const kindDirectory = await root.getDirectoryHandle(storage.packageKind, { create })
  return kindDirectory.getDirectoryHandle(storage.directoryName, { create })
}

function validatePath(path: string): string[] {
  const parts = path.split('/').filter(Boolean)
  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) {
    throw new Error(`Invalid package file path: ${path}`)
  }
  return parts
}

async function resolveParentDirectory(
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
): Promise<{ directory: FileSystemDirectoryHandle; fileName: string }> {
  const parts = validatePath(path)
  const fileName = parts.pop()
  if (!fileName) {
    throw new Error(`Invalid package file path: ${path}`)
  }
  let directory = root
  for (const part of parts) {
    directory = await directory.getDirectoryHandle(part, { create })
  }
  return { directory, fileName }
}

export async function writePackageFile(
  storage: DirectoryPayloadStorage,
  path: string,
  data: Blob | BufferSource | string,
): Promise<void> {
  const root = await getPackageDirectory(storage, true)
  const { directory, fileName } = await resolveParentDirectory(root, path, true)
  const fileHandle = await directory.getFileHandle(fileName, { create: true })
  const writable = await fileHandle.createWritable()
  try {
    await writable.write(data)
  } finally {
    await writable.close()
  }
}

export async function createPackageWritable(
  storage: DirectoryPayloadStorage,
  path: string,
): Promise<FileSystemWritableFileStream> {
  const root = await getPackageDirectory(storage, true)
  const { directory, fileName } = await resolveParentDirectory(root, path, true)
  const fileHandle = await directory.getFileHandle(fileName, { create: true })
  return fileHandle.createWritable()
}

export async function readPackageFile(
  storage: DirectoryPayloadStorage,
  path: string,
): Promise<File> {
  const root = await getPackageDirectory(storage)
  const { directory, fileName } = await resolveParentDirectory(root, path, false)
  const fileHandle = await directory.getFileHandle(fileName)
  return fileHandle.getFile()
}

export async function deletePackageEntry(
  storage: DirectoryPayloadStorage,
  path: string,
  recursive = false,
): Promise<void> {
  const root = await getPackageDirectory(storage)
  const parts = validatePath(path)
  const entryName = parts.pop()
  if (!entryName) {
    throw new Error(`Invalid package entry path: ${path}`)
  }
  let directory = root
  for (const part of parts) {
    directory = await directory.getDirectoryHandle(part)
  }
  try {
    await directory.removeEntry(entryName, { recursive })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') {
      return
    }
    throw error
  }
}

export async function writePackageJson(
  storage: DirectoryPayloadStorage,
  path: string,
  value: unknown,
): Promise<void> {
  await writePackageFile(
    storage,
    path,
    JSON.stringify(value),
  )
}

export async function readPackageJson<T>(
  storage: DirectoryPayloadStorage,
  path: string,
): Promise<T> {
  const file = await readPackageFile(storage, path)
  return JSON.parse(await file.text()) as T
}

export async function deletePackageDirectory(
  storage: DirectoryPayloadStorage,
): Promise<void> {
  const destination = await getDestinationRecord(storage.destinationId)
  try {
    const root = await destination.handle.getDirectoryHandle(packageRootName)
    const kindDirectory = await root.getDirectoryHandle(storage.packageKind)
    await kindDirectory.removeEntry(storage.directoryName, { recursive: true })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') {
      return
    }
    throw error
  }
}
