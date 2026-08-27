import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createVideoTimeline: vi.fn(),
  deletePackage: vi.fn(),
  encodeVideoFrames: vi.fn(),
  finalizePackage: vi.fn(),
  getFrame: vi.fn(),
  getVideoOutputSize: vi.fn(),
  putAsset: vi.fn(),
  putFrame: vi.fn(),
  putPackage: vi.fn(),
  takeMapOnlyScreenshot: vi.fn(),
  viewpointFromJson: vi.fn((json: unknown) => ({ json })),
}))

vi.mock('@arcgis/core/Viewpoint.js', () => ({
  default: {
    fromJSON: mocks.viewpointFromJson,
  },
}))

vi.mock('../storage/database.ts', () => ({
  deletePackage: mocks.deletePackage,
  finalizePackage: mocks.finalizePackage,
  getFrame: mocks.getFrame,
  putAsset: mocks.putAsset,
  putFrame: mocks.putFrame,
  putPackage: mocks.putPackage,
}))

vi.mock('./timeline.ts', () => ({
  createVideoTimeline: mocks.createVideoTimeline,
  estimateVideoCapture: vi.fn(() => ({
    durationMs: 3_000,
    frameCount: 3,
    workingBytes: 64,
  })),
}))

vi.mock('./video-encoder.ts', () => ({
  encodeVideoFrames: mocks.encodeVideoFrames,
}))

vi.mock('./view-state.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./view-state.ts')>()
  return {
    ...actual,
    getVideoOutputSize: mocks.getVideoOutputSize,
    takeMapOnlyScreenshot: mocks.takeMapOnlyScreenshot,
  }
})

import { captureOfflineVideo } from './capture-offline-video.ts'

function createSerializable<T>(value: T) {
  return {
    toJSON: () => value,
  }
}

function createTimelinePlan() {
  return {
    durationMs: 3_000,
    frames: [
      {
        index: 0,
        layers: [
          { id: 'roads', opacity: 1, title: 'Roads', visible: true },
          { id: 'labels', opacity: 0.25, title: 'Labels', visible: false },
        ],
        sceneId: 'scene-1',
        timeMs: 0,
        viewpoint: { id: 'scene-1' },
      },
      {
        index: 1,
        layers: [
          { id: 'roads', opacity: 1, title: 'Roads', visible: true },
          { id: 'labels', opacity: 1, title: 'Labels', visible: true },
        ],
        timeMs: 1_000,
        viewpoint: { id: 'transition-1' },
      },
      {
        index: 2,
        layers: [
          { id: 'roads', opacity: 0.5, title: 'Roads', visible: false },
          { id: 'labels', opacity: 1, title: 'Labels', visible: true },
        ],
        sceneId: 'scene-2',
        timeMs: 2_000,
        viewpoint: { id: 'scene-2' },
      },
    ],
    scenes: [
      {
        holdEndMs: 1_000,
        holdStartMs: 0,
        id: 'scene-1',
        index: 0,
        layers: [{ id: 'roads', opacity: 1, title: 'Roads', visible: true }],
        name: 'Scene 1',
        timestampMs: 500,
        transitionStartMs: 0,
        viewpoint: { id: 'scene-1' },
      },
      {
        holdEndMs: 3_000,
        holdStartMs: 1_500,
        id: 'scene-2',
        index: 1,
        layers: [{ id: 'roads', opacity: 0.5, title: 'Roads', visible: false }],
        name: 'Scene 2',
        timestampMs: 2_250,
        transitionStartMs: 1_000,
        viewpoint: { id: 'scene-2' },
      },
    ],
  }
}

function createSession() {
  const layers = [
    { id: 'roads', opacity: 0.2, title: 'Roads', visible: false },
    { id: 'labels', opacity: 0.8, title: 'Labels', visible: true },
  ]
  const popup = { visible: true }
  const view: {
    goTo: ReturnType<typeof vi.fn>
    popup: typeof popup
    viewpoint: { toJSON: () => unknown }
  } = {
    goTo: vi.fn(async (viewpoint: { json: unknown }) => {
      view.viewpoint = createSerializable(viewpoint.json)
    }),
    popup,
    viewpoint: createSerializable({ id: 'original-viewpoint' }),
  }
  return {
    item: {
      access: 'public',
      id: 'webmap-1',
      modified: 1,
      owner: 'owner',
      title: 'Test WebMap',
      type: 'Web Map',
    },
    itemData: {},
    map: {
      allLayers: {
        toArray: () => layers,
      },
    },
    view,
  }
}

function installVerifiedVideo(durationSeconds: number) {
  const seekedTimesMs: number[] = []
  const listeners = new Map<string, Set<(event?: Event) => void>>()
  let currentTimeSeconds = 0
  let src = ''
  const load = vi.fn(() => {
    if (src) {
      queueMicrotask(() => {
        video.readyState = HTMLMediaElement.HAVE_CURRENT_DATA
        dispatch('loadedmetadata')
        dispatch('loadeddata')
      })
    }
  })
  const dispatch = (type: string, event?: Event) => {
    for (const listener of listeners.get(type) ?? []) {
      listener(event)
    }
  }
  const video = {
    addEventListener(type: string, callback: (event?: Event) => void) {
      const registered = listeners.get(type) ?? new Set()
      registered.add(callback)
      listeners.set(type, registered)
    },
    duration: durationSeconds,
    load,
    preload: 'auto',
    readyState: 0,
    removeAttribute(name: string) {
      if (name === 'src') {
        src = ''
        video.readyState = 0
      }
    },
    removeEventListener(type: string, callback: (event?: Event) => void) {
      listeners.get(type)?.delete(callback)
    },
    get currentTime() {
      return currentTimeSeconds
    },
    set currentTime(value: number) {
      currentTimeSeconds = value
      seekedTimesMs.push(value * 1_000)
      queueMicrotask(() => dispatch('seeked'))
    },
    get src() {
      return src
    },
    set src(value: string) {
      src = value
    },
  }
  const originalCreateElement = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
    if (tagName === 'video') {
      return video as unknown as HTMLVideoElement
    }
    return originalCreateElement(tagName)
  }) as typeof document.createElement)
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:video'),
    revokeObjectURL: vi.fn(),
  })

  return { seekedTimesMs, video }
}

describe('captureOfflineVideo', () => {
  const frameStore = new Map<number, Blob>()

  beforeEach(() => {
    vi.clearAllMocks()
    frameStore.clear()
    mocks.createVideoTimeline.mockReturnValue(createTimelinePlan())
    mocks.deletePackage.mockResolvedValue(undefined)
    mocks.finalizePackage.mockImplementation(async (packageRecord) => ({
      ...packageRecord,
      completedAt: 123,
      state: 'complete',
    }))
    mocks.getFrame.mockImplementation(async (_packageId: string, index: number) => {
      const blob = frameStore.get(index)
      return blob ? {
        blob,
        frameId: `pkg-1:${index}`,
        index,
        packageId: 'pkg-1',
      } : undefined
    })
    mocks.getVideoOutputSize.mockReturnValue({ height: 720, width: 1_280 })
    mocks.putAsset.mockResolvedValue(undefined)
    mocks.putFrame.mockImplementation(async (frame: { blob: Blob; index: number }) => {
      frameStore.set(frame.index, frame.blob)
    })
    mocks.putPackage.mockResolvedValue(undefined)
    let captureIndex = 0
    mocks.takeMapOnlyScreenshot.mockImplementation(async () => {
      captureIndex += 1
      return new Blob([`capture-${captureIndex}`], { type: 'image/png' })
    })
    mocks.viewpointFromJson.mockImplementation((json: unknown) => ({ json }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('restores the live map before encoding and stores measured scene timestamps', async () => {
    const session = createSession()
    const { seekedTimesMs } = installVerifiedVideo(2.4)
    mocks.encodeVideoFrames.mockImplementation(async ({ frameCount, getFrame }) => {
      expect(frameCount).toBe(3)
      expect(session.view.popup.visible).toBe(true)
      expect(session.map.allLayers.toArray()).toMatchObject([
        { id: 'roads', opacity: 0.2, visible: false },
        { id: 'labels', opacity: 0.8, visible: true },
      ])
      expect(session.view.viewpoint.toJSON()).toEqual({ id: 'original-viewpoint' })
      expect(await Promise.all([
        getFrame(0).then((blob: Blob) => blob.text()),
        getFrame(1).then((blob: Blob) => blob.text()),
        getFrame(2).then((blob: Blob) => blob.text()),
      ])).toEqual(['thumbnail', 'capture-1', 'thumbnail'])
      return {
        blob: new Blob(['video'], { type: 'video/webm' }),
        mimeType: 'video/webm',
      }
    })

    const completed = await captureOfflineVideo({
      assets: [{
        assetId: 'asset-1',
        blob: new Blob(['asset']),
        contentType: 'application/octet-stream',
        kind: 'attachment',
        packageId: 'draft-1',
      }],
      options: {
        onProgress: vi.fn(),
        signal: new AbortController().signal,
      },
      packageId: 'pkg-1',
      session: session as never,
      views: [{
        capturedAt: 1,
        extent: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
        id: 'scene-1',
        layers: [],
        name: 'View 1',
        thumbnailBlob: new Blob(['thumbnail']),
        viewpoint: { id: 'view-1' },
      }, {
        capturedAt: 2,
        extent: { xmin: 1, ymin: 1, xmax: 2, ymax: 2 },
        id: 'scene-2',
        layers: [],
        name: 'View 2',
        thumbnailBlob: new Blob(['thumbnail']),
        viewpoint: { id: 'view-2' },
      }],
    })

    expect(mocks.putFrame.mock.calls.map(([frame]) => frame.sceneId)).toEqual([
      'scene-1',
      undefined,
      'scene-2',
    ])
    const finalizedPackage = mocks.finalizePackage.mock.calls[0]?.[0]
    expect(finalizedPackage?.durationMs).toBe(2_400)
    expect(finalizedPackage?.scenes).toMatchObject([
      {
        holdEndMs: 800,
        holdStartMs: 0,
        timestampMs: 400,
        transitionStartMs: 0,
      },
      {
        holdEndMs: 2_400,
        holdStartMs: 1_200,
        timestampMs: 1_800,
        transitionStartMs: 800,
      },
    ])
    expect(seekedTimesMs).toEqual([400, 1_800])
    expect(completed).toMatchObject({
      durationMs: 2_400,
      state: 'complete',
      videoMimeType: 'video/webm',
    })
  })

  it('deletes staged data and restores the live map after a frame-capture failure', async () => {
    const session = createSession()
    mocks.takeMapOnlyScreenshot.mockRejectedValueOnce(new Error('frame capture failed'))
    mocks.encodeVideoFrames.mockResolvedValue({
      blob: new Blob(['video'], { type: 'video/webm' }),
      mimeType: 'video/webm',
    })

    await expect(captureOfflineVideo({
      assets: [],
      options: {
        onProgress: vi.fn(),
        signal: new AbortController().signal,
      },
      packageId: 'pkg-1',
      session: session as never,
      views: [{
        capturedAt: 1,
        extent: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
        id: 'view-1',
        layers: [],
        name: 'View 1',
        thumbnailBlob: new Blob(['thumbnail']),
        viewpoint: { id: 'view-1' },
      }],
    })).rejects.toThrow('frame capture failed')

    expect(mocks.deletePackage).toHaveBeenCalledWith('pkg-1')
    expect(mocks.encodeVideoFrames).not.toHaveBeenCalled()
    expect(session.view.popup.visible).toBe(true)
    expect(session.map.allLayers.toArray()).toMatchObject([
      { id: 'roads', opacity: 0.2, visible: false },
      { id: 'labels', opacity: 0.8, visible: true },
    ])
    expect(session.view.viewpoint.toJSON()).toEqual({ id: 'original-viewpoint' })
  })
})
