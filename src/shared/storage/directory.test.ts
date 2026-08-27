import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chooseDirectory,
  clearSelectedDirectory,
  createDirectoryStorageReference,
  getPackageDirectory,
  getSelectedDirectory,
  readPackageFile,
  reconnectDirectory,
  writePackageFile,
} from './directory.ts'
import {
  queueDirectoryCleanup,
  retryDirectoryCleanup,
} from './directory-cleanup.ts'

class FakeFileHandle {
  readonly kind = 'file'
  readonly name: string
  private value = new Blob()

  constructor(name: string) {
    this.name = name
  }

  async createWritable() {
    return {
      close: vi.fn(async () => undefined),
      write: vi.fn(async (value: Blob | BufferSource | string) => {
        this.value = value instanceof Blob ? value : new Blob([value])
      }),
    }
  }

  async getFile() {
    return new File([this.value], this.name, { type: this.value.type })
  }
}

class FakeDirectoryHandle {
  readonly kind = 'directory'
  readonly name: string
  permission: PermissionState = 'granted'
  readonly directories = new Map<string, FakeDirectoryHandle>()
  readonly files = new Map<string, FakeFileHandle>()

  constructor(name: string) {
    this.name = name
  }

  async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions) {
    const existing = this.directories.get(name)
    if (existing) {
      return existing
    }
    if (!options?.create) {
      throw new DOMException('Directory not found', 'NotFoundError')
    }
    const directory = new FakeDirectoryHandle(name)
    this.directories.set(name, directory)
    return directory
  }

  async getFileHandle(name: string, options?: FileSystemGetFileOptions) {
    const existing = this.files.get(name)
    if (existing) {
      return existing
    }
    if (!options?.create) {
      throw new DOMException('File not found', 'NotFoundError')
    }
    const file = new FakeFileHandle(name)
    this.files.set(name, file)
    return file
  }

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return other === this
  }

  async queryPermission() {
    return this.permission
  }

  async removeEntry(name: string) {
    if (!this.directories.delete(name) && !this.files.delete(name)) {
      throw new DOMException('Entry not found', 'NotFoundError')
    }
  }

  async requestPermission() {
    return this.permission
  }
}

function asDirectoryHandle(handle: FakeDirectoryHandle): FileSystemDirectoryHandle {
  return handle as never
}

describe('folder-backed package storage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('persists a selected destination and reads, revokes, reconnects, and deletes package files', async () => {
    const root = new FakeDirectoryHandle('Offline packages')
    Object.defineProperty(window, 'isSecureContext', {
      configurable: true,
      value: true,
    })
    vi.stubGlobal('showDirectoryPicker', vi.fn(async () => asDirectoryHandle(root)))
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: vi.fn(async () => asDirectoryHandle(root)),
    })

    const destination = await chooseDirectory()
    const storage = createDirectoryStorageReference(
      destination,
      'offline-video',
      'video-test',
    )
    await writePackageFile(storage, 'frames/0.txt', 'frame data')

    expect((await getSelectedDirectory())?.name).toBe('Offline packages')
    expect(await (await readPackageFile(storage, 'frames/0.txt')).text()).toBe('frame data')

    root.permission = 'prompt'
    await expect(getPackageDirectory(storage)).rejects.toThrow('Reconnect')
    root.permission = 'granted'
    await expect(reconnectDirectory(destination.id)).resolves.toMatchObject({
      permission: 'granted',
    })

    await queueDirectoryCleanup('video-test', storage)
    root.permission = 'prompt'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(retryDirectoryCleanup('offline-video')).resolves.toEqual({
      pending: 1,
      removed: 0,
    })
    expect(warn).toHaveBeenCalledOnce()
    root.permission = 'granted'
    await expect(retryDirectoryCleanup('offline-video')).resolves.toEqual({
      pending: 0,
      removed: 1,
    })
    await expect(readPackageFile(storage, 'frames/0.txt')).rejects.toThrow()
    await clearSelectedDirectory()
    await expect(getSelectedDirectory()).resolves.toBeUndefined()
  })
})
