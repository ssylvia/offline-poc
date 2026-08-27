import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedVideoPackage, VideoPackageAsset } from './types.ts'
import {
  createVideoExportManifest,
  downloadBlob,
  getVideoExportBaseName,
} from './export.ts'

const packageRecord: SavedVideoPackage = {
  byteSize: 12,
  completedAt: 2,
  createdAt: 1,
  durationMs: 1_500,
  frameRate: 10,
  height: 720,
  item: {
    access: 'public',
    id: 'a'.repeat(32),
    modified: 1,
    owner: 'owner',
    title: 'Café & Streets',
    type: 'Web Map',
  },
  packageId: 'package-12345678',
  itemData: {},
  scenes: [],
  schemaVersion: 1,
  state: 'complete',
  thumbnailBlob: new Blob(['thumb'], { type: 'image/png' }),
  videoBlob: new Blob(['video'], { type: 'video/webm' }),
  videoMimeType: 'video/webm',
  warnings: [],
  width: 1280,
}

describe('offline video export', () => {
  const createObjectURL = vi.fn()
  const revokeObjectURL = vi.fn()

  beforeEach(() => {
    let nextUrlId = 0
    createObjectURL.mockImplementation(() => `blob:${++nextUrlId}`)
    revokeObjectURL.mockReset()
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('creates stable safe filenames', () => {
    expect(getVideoExportBaseName(packageRecord)).toBe('cafe-streets-12345678')
  })

  it('embeds popup assets in the JSON sidecar', async () => {
    const assets: VideoPackageAsset[] = [{
      assetId: 'asset-1',
      blob: new Blob(['hello'], { type: 'text/plain' }),
      contentType: 'text/plain',
      fileName: 'hello.txt',
      kind: 'attachment',
      packageId: packageRecord.packageId,
    }]

    const manifest = await createVideoExportManifest(packageRecord, assets)

    expect(manifest.video.fileName).toBe('cafe-streets-12345678.webm')
    expect(manifest.assets[0]).toMatchObject({
      assetId: 'asset-1',
      contentType: 'text/plain',
      fileName: 'hello.txt',
    })
    expect(manifest.assets[0].dataUrl).toMatch(/^data:text\/plain;base64,/)
  })

  it('uses an MP4 filename for H.264 packages', async () => {
    const manifest = await createVideoExportManifest({
      ...packageRecord,
      videoBlob: new Blob(['video'], { type: 'video/mp4' }),
      videoMimeType: 'video/mp4',
    }, [])

    expect(manifest.video.fileName).toBe('cafe-streets-12345678.mp4')
  })

  it('rejects incomplete packages without video bytes', async () => {
    await expect(createVideoExportManifest(
      { ...packageRecord, videoBlob: undefined },
      [],
    )).rejects.toThrow('does not contain')
  })

  it('downloads exported blobs through temporary links and revokes object URLs', () => {
    vi.useFakeTimers()
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    downloadBlob(new Blob(['video'], { type: 'video/webm' }), 'capture.webm')

    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(document.body.querySelector('a[download="capture.webm"]')).toBeNull()

    vi.runAllTimers()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:1')
    vi.useRealTimers()
  })
})
