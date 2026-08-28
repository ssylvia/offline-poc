import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SavedVideoPackage, VideoCaptureFrame, VideoPackageAsset } from '../types.ts'
import {
  DEFAULT_STALE_STAGING_MAX_AGE_MS,
  deletePackage,
  finalizePackage,
  getSavedPackage,
  getFrameById,
  listAssets,
  listFrames,
  listSavedPackages,
  putAsset,
  putFrame,
  putPackage,
  removeStaleStagingPackages,
} from './database.ts'

let idCounter = 0

function nextId(prefix: string): string {
  idCounter += 1
  return `${prefix}-${idCounter}`
}

function createPackage(overrides: Partial<SavedVideoPackage> = {}): SavedVideoPackage {
  const packageId = overrides.packageId ?? nextId('package')
  const itemId = overrides.item?.id ?? nextId('webmap')
  const { item: itemOverrides, ...packageOverrides } = overrides

  return {
    byteSize: 1_024,
    createdAt: packageOverrides.createdAt ?? Date.now(),
    durationMs: 3_000,
    frameRate: 10,
    height: 720,
    item: {
      access: 'public',
      id: itemId,
      modified: 1,
      owner: 'test-owner',
      title: 'Test WebMap',
      type: 'Web Map',
      ...itemOverrides,
    },
    itemData: {},
    packageId,
    schemaVersion: 1,
    scenes: [],
    state: 'staging',
    thumbnailBlob: new Blob(['thumbnail'], { type: 'image/png' }),
    videoMimeType: 'video/webm',
    warnings: [],
    width: 1_280,
    ...packageOverrides,
  }
}

function createAsset(
  packageId: string,
  overrides: Partial<VideoPackageAsset> = {},
): VideoPackageAsset {
  return {
    assetId: overrides.assetId ?? nextId('asset'),
    blob: new Blob(['asset'], { type: 'image/png' }),
    contentType: 'image/png',
    kind: 'popup-media',
    packageId,
    ...overrides,
  }
}

function createFrame(
  packageId: string,
  index: number,
  overrides: Partial<VideoCaptureFrame> = {},
): VideoCaptureFrame {
  return {
    blob: new Blob([`frame-${index}`], { type: 'image/png' }),
    frameId: overrides.frameId ?? nextId('frame'),
    index,
    packageId,
    ...overrides,
  }
}

describe('offline video storage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps staging packages invisible until they are finalized', async () => {
    const stagingPackage = createPackage()
    const stagedFrame = createFrame(stagingPackage.packageId, 0)

    await putPackage(stagingPackage)
    await putFrame(stagedFrame)

    expect(await listSavedPackages(stagingPackage.item.id)).toEqual([])
    expect(await getSavedPackage(stagingPackage.packageId)).toBeUndefined()
    expect((await listFrames(stagingPackage.packageId)).map((entry) => entry.frameId)).toEqual([
      stagedFrame.frameId,
    ])
    expect(await getFrameById(stagingPackage.packageId, stagedFrame.frameId)).toMatchObject({
      frameId: stagedFrame.frameId,
      index: 0,
    })
  })

  it('finalizes packages by publishing metadata and clearing temporary frames', async () => {
    const stagingPackage = createPackage()
    const asset = createAsset(stagingPackage.packageId)
    const frame = createFrame(stagingPackage.packageId, 0)

    await putPackage(stagingPackage)
    await putAsset(asset)
    await putFrame(frame)

    vi.spyOn(Date, 'now').mockReturnValue(stagingPackage.createdAt + 50)
    const completedPackage = await finalizePackage(stagingPackage)

    expect(completedPackage.state).toBe('complete')
    expect(completedPackage.completedAt).toBe(stagingPackage.createdAt + 50)
    expect((await listSavedPackages(stagingPackage.item.id)).map((entry) => entry.packageId)).toEqual([
      stagingPackage.packageId,
    ])
    expect(await getSavedPackage(stagingPackage.packageId)).toMatchObject({
      completedAt: stagingPackage.createdAt + 50,
      packageId: stagingPackage.packageId,
      state: 'complete',
    })
    expect(await listFrames(stagingPackage.packageId)).toEqual([])
    expect((await listAssets(stagingPackage.packageId)).map((entry) => entry.assetId)).toEqual([
      asset.assetId,
    ])
  })

  it('lists multiple finalized videos for the same webmap', async () => {
    const itemId = nextId('webmap')
    const firstPackage = createPackage({
      item: {
        access: 'public',
        id: itemId,
        modified: 1,
        owner: 'test-owner',
        title: 'Test WebMap',
        type: 'Web Map',
      },
    })
    const secondPackage = createPackage({
      item: {
        access: 'public',
        id: itemId,
        modified: 2,
        owner: 'test-owner',
        title: 'Test WebMap',
        type: 'Web Map',
      },
    })

    await putPackage(firstPackage)
    await putPackage(secondPackage)

    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(firstPackage.createdAt + 100)
    await finalizePackage(firstPackage)
    nowSpy.mockReturnValueOnce(secondPackage.createdAt + 200)
    await finalizePackage(secondPackage)

    expect((await listSavedPackages(itemId)).map((entry) => entry.packageId)).toEqual([
      secondPackage.packageId,
      firstPackage.packageId,
    ])
  })

  it('removes stale staging packages and keeps recent staging work', async () => {
    const now = Date.now()
    const stalePackage = createPackage({
      createdAt: now - DEFAULT_STALE_STAGING_MAX_AGE_MS - 1,
    })

    const recentPackage = createPackage({ createdAt: now })
    const completedPackage = createPackage()

    await putPackage(stalePackage)
    await putAsset(createAsset(stalePackage.packageId))
    await putFrame(createFrame(stalePackage.packageId, 0))

    await putPackage(recentPackage)
    await putFrame(createFrame(recentPackage.packageId, 0))

    await putPackage(completedPackage)
    vi.spyOn(Date, 'now').mockReturnValue(now + 10)
    await finalizePackage(completedPackage)

    await removeStaleStagingPackages({ now })

    expect(await listAssets(stalePackage.packageId)).toEqual([])
    expect(await listFrames(stalePackage.packageId)).toEqual([])
    expect((await listFrames(recentPackage.packageId)).map((entry) => entry.index)).toEqual([0])
    expect((await listSavedPackages(completedPackage.item.id)).map((entry) => entry.packageId)).toEqual([
      completedPackage.packageId,
    ])
  })

  it('does not hide valid videos when stale folder cleanup needs permission', async () => {
    const now = Date.now()
    const stalePackage = createPackage({
      createdAt: now - DEFAULT_STALE_STAGING_MAX_AGE_MS - 1,
      payloadStorage: {
        destinationId: nextId('missing-destination'),
        directoryName: 'stale-video',
        kind: 'directory',
        packageKind: 'offline-video',
      },
    })
    const completedPackage = createPackage()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await putPackage(stalePackage)
    await putFrame(createFrame(stalePackage.packageId, 0))
    await putPackage(completedPackage)
    await finalizePackage(completedPackage)

    await removeStaleStagingPackages({ now })

    expect(warn).toHaveBeenCalledOnce()
    expect(await listFrames(stalePackage.packageId)).toEqual([])
    expect((await listSavedPackages(completedPackage.item.id)).map((entry) => entry.packageId)).toEqual([
      completedPackage.packageId,
    ])
  })

  it('deletes packages together with their related assets and frames', async () => {
    const packageRecord = createPackage()
    const assets = [
      createAsset(packageRecord.packageId, { kind: 'attachment' }),
      createAsset(packageRecord.packageId, { kind: 'fallback-image' }),
    ]
    const frames = [
      createFrame(packageRecord.packageId, 0),
      createFrame(packageRecord.packageId, 1),
    ]

    await putPackage(packageRecord)
    await Promise.all([
      ...assets.map((asset) => putAsset(asset)),
      ...frames.map((frame) => putFrame(frame)),
    ])

    await deletePackage(packageRecord.packageId)

    expect(await getSavedPackage(packageRecord.packageId)).toBeUndefined()
    expect(await listAssets(packageRecord.packageId)).toEqual([])
    expect(await listFrames(packageRecord.packageId)).toEqual([])
  })
})
