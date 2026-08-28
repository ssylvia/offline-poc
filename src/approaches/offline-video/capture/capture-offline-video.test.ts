import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VideoCaptureFrame, VideoDraftView } from '../types.ts'

const mocks = vi.hoisted(() => ({
  composeZoomTimelineFrame: vi.fn(),
  createVideoCaptureViewport: vi.fn(),
  createVideoTimeline: vi.fn(),
  deleteFrame: vi.fn(),
  deletePackage: vi.fn(),
  destroyCaptureViewport: vi.fn(),
  encodeVideoFrames: vi.fn(),
  finalizePackage: vi.fn(),
  getFrame: vi.fn(),
  getFrameById: vi.fn(),
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
  deleteFrame: mocks.deleteFrame,
  deletePackage: mocks.deletePackage,
  finalizePackage: mocks.finalizePackage,
  getFrame: mocks.getFrame,
  getFrameById: mocks.getFrameById,
  putAsset: mocks.putAsset,
  putFrame: mocks.putFrame,
  putPackage: mocks.putPackage,
}))

vi.mock('./capture-viewport.ts', () => ({
  createVideoCaptureViewport: mocks.createVideoCaptureViewport,
}))

vi.mock('./timeline.ts', () => ({
  createVideoTimeline: mocks.createVideoTimeline,
  estimateVideoCapture: vi.fn(() => ({
    durationMs: 4_000,
    frameCount: 4,
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
    composeZoomTimelineFrame: mocks.composeZoomTimelineFrame,
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
  const sourceLayers = [
    { id: 'roads', opacity: 1, title: 'Roads', visible: true },
    { id: 'labels', opacity: 1, title: 'Labels', visible: false },
  ]
  const destinationLayers = [
    { id: 'roads', opacity: 1, title: 'Roads', visible: false },
    { id: 'labels', opacity: 1, title: 'Labels', visible: true },
  ]
  return {
    durationMs: 4_000,
    frames: [
      {
        index: 0,
        layers: sourceLayers,
        phase: 'hold',
        sceneId: 'scene-1',
        timeMs: 0,
        viewpoint: { scale: 2_000, targetGeometry: { x: 0, y: 0 } },
      },
      {
        destinationScale: 1_000,
        index: 1,
        layerProgress: 0.2,
        layers: sourceLayers,
        panProgress: 0.2,
        phase: 'transition',
        sourceScale: 2_000,
        timeMs: 1_000,
        transitionFromSceneId: 'scene-1',
        transitionProgress: 0.2,
        transitionToSceneId: 'scene-2',
        viewpoint: { scale: 2_000, targetGeometry: { x: 20, y: 0 } },
        zoomProgress: 0.2,
      },
      {
        destinationScale: 1_000,
        index: 2,
        layerProgress: 0.9,
        layers: sourceLayers,
        panProgress: 0.9,
        phase: 'transition',
        sourceScale: 2_000,
        timeMs: 2_000,
        transitionFromSceneId: 'scene-1',
        transitionProgress: 0.9,
        transitionToSceneId: 'scene-2',
        viewpoint: { scale: 2_000, targetGeometry: { x: 90, y: 0 } },
        zoomProgress: 0.9,
      },
      {
        index: 3,
        layers: destinationLayers,
        phase: 'hold',
        sceneId: 'scene-2',
        timeMs: 3_000,
        viewpoint: { scale: 1_000, targetGeometry: { x: 100, y: 0 } },
      },
    ],
    scenes: [
      {
        holdEndMs: 1_000,
        holdStartMs: 0,
        id: 'scene-1',
        index: 0,
        layers: sourceLayers,
        name: 'Scene 1',
        timestampMs: 500,
        transitionStartMs: 0,
        viewpoint: { scale: 2_000, targetGeometry: { x: 0, y: 0 } },
      },
      {
        holdEndMs: 4_000,
        holdStartMs: 3_000,
        id: 'scene-2',
        index: 1,
        layers: destinationLayers,
        name: 'Scene 2',
        timestampMs: 3_500,
        transitionStartMs: 1_000,
        viewpoint: { scale: 1_000, targetGeometry: { x: 100, y: 0 } },
      },
    ],
  }
}

function createViews(): VideoDraftView[] {
  return [{
    capturedAt: 1,
    extent: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
    id: 'scene-1',
    layers: [
      { id: 'roads', opacity: 1, title: 'Roads', visible: true },
      { id: 'labels', opacity: 1, title: 'Labels', visible: false },
    ],
    name: 'Scene 1',
    thumbnailBlob: new Blob(['draft-thumbnail']),
    viewpoint: { scale: 2_000, targetGeometry: { x: 0, y: 0 } },
  }, {
    capturedAt: 2,
    extent: { xmin: 1, ymin: 1, xmax: 2, ymax: 2 },
    id: 'scene-2',
    layers: [
      { id: 'roads', opacity: 1, title: 'Roads', visible: false },
      { id: 'labels', opacity: 1, title: 'Labels', visible: true },
    ],
    name: 'Scene 2',
    thumbnailBlob: new Blob(['draft-thumbnail']),
    viewpoint: { scale: 1_000, targetGeometry: { x: 100, y: 0 } },
  }]
}

function createSession() {
  const layers = [
    { id: 'roads', opacity: 0.2, title: 'Roads', visible: false },
    { id: 'labels', opacity: 0.8, title: 'Labels', visible: true },
  ]
  const popup = { visible: true }
  const liveView = {
    goTo: vi.fn(),
    popup,
    viewpoint: createSerializable({ id: 'original-viewpoint' }),
  }
  const captureView = {
    goTo: vi.fn(async (viewpoint: { json: unknown }) => {
      captureView.viewpoint = viewpoint.json
    }),
    viewpoint: {} as unknown,
  }
  return {
    captureView,
    session: {
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
      view: liveView,
    },
  }
}

function installVerifiedVideo(durationSeconds: number) {
  const listeners = new Map<string, Set<() => void>>()
  let currentTimeSeconds = 0
  let src = ''
  const dispatch = (type: string) => {
    for (const listener of listeners.get(type) ?? []) {
      listener()
    }
  }
  const video = {
    addEventListener(type: string, callback: () => void) {
      const callbacks = listeners.get(type) ?? new Set()
      callbacks.add(callback)
      listeners.set(type, callbacks)
    },
    duration: durationSeconds,
    load() {
      if (src) {
        queueMicrotask(() => {
          video.readyState = HTMLMediaElement.HAVE_CURRENT_DATA
          dispatch('loadedmetadata')
          dispatch('loadeddata')
        })
      }
    },
    preload: 'auto',
    readyState: 0,
    removeAttribute() {
      src = ''
      video.readyState = 0
    },
    removeEventListener(type: string, callback: () => void) {
      listeners.get(type)?.delete(callback)
    },
    get currentTime() {
      return currentTimeSeconds
    },
    set currentTime(value: number) {
      currentTimeSeconds = value
      queueMicrotask(() => dispatch('seeked'))
    },
    get src() {
      return src
    },
    set src(value: string) {
      src = value
    },
  }
  const createElement = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => (
    tagName === 'video'
      ? video as unknown as HTMLVideoElement
      : createElement(tagName)
  )) as typeof document.createElement)
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:video'),
    revokeObjectURL: vi.fn(),
  })
}

describe('captureOfflineVideo', () => {
  const frameStoreById = new Map<string, VideoCaptureFrame>()
  const frameStoreByIndex = new Map<number, VideoCaptureFrame>()

  beforeEach(() => {
    vi.clearAllMocks()
    frameStoreById.clear()
    frameStoreByIndex.clear()
    mocks.createVideoTimeline.mockReturnValue(createTimelinePlan())
    mocks.deleteFrame.mockImplementation(async (_packageId: string, frameId: string) => {
      const frame = frameStoreById.get(frameId)
      frameStoreById.delete(frameId)
      if (frame) {
        frameStoreByIndex.delete(frame.index)
      }
    })
    mocks.deletePackage.mockResolvedValue(undefined)
    mocks.finalizePackage.mockImplementation(async (packageRecord) => ({
      ...packageRecord,
      completedAt: 123,
      state: 'complete',
    }))
    mocks.getFrame.mockImplementation(async (_packageId: string, index: number) => (
      frameStoreByIndex.get(index)
    ))
    mocks.getFrameById.mockImplementation(async (_packageId: string, frameId: string) => (
      frameStoreById.get(frameId)
    ))
    mocks.putAsset.mockResolvedValue(undefined)
    mocks.putFrame.mockImplementation(async (frame: VideoCaptureFrame) => {
      frameStoreById.set(frame.frameId, frame)
      frameStoreByIndex.set(frame.index, frame)
    })
    mocks.putPackage.mockResolvedValue(undefined)
    mocks.composeZoomTimelineFrame.mockImplementation(async (images) => new Blob([
      `composite:${images.length}`,
    ], { type: 'image/png' }))
    mocks.viewpointFromJson.mockImplementation((json: unknown) => ({ json }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('captures complete zoom timelines level-by-level in a fixed viewport', async () => {
    const { captureView, session } = createSession()
    mocks.createVideoCaptureViewport.mockResolvedValue({
      destroy: mocks.destroyCaptureViewport,
      view: captureView,
    })
    mocks.takeMapOnlyScreenshot.mockImplementation(async () => new Blob([
      JSON.stringify({
        layers: session.map.allLayers.toArray().map((layer) => ({
          id: layer.id,
          opacity: layer.opacity,
          visible: layer.visible,
        })),
        viewpoint: captureView.viewpoint,
      }),
    ], { type: 'image/png' }))
    mocks.encodeVideoFrames.mockImplementation(async ({ frameCount, getFrame }) => {
      expect(frameCount).toBe(4)
      expect(await Promise.all(
        Array.from({ length: frameCount }, (_, index) => (
          getFrame(index).then((blob: Blob) => blob.text())
        )),
      )).toEqual([
        expect.stringContaining('"scale":2000'),
        'composite:1',
        'composite:2',
        expect.stringContaining('"scale":1000'),
      ])
      return {
        blob: new Blob(['video'], { type: 'video/webm' }),
        fileName: 'video.webm',
        mimeType: 'video/webm',
      }
    })
    installVerifiedVideo(4)

    const completed = await captureOfflineVideo({
      assets: [],
      options: {
        onProgress: vi.fn(),
        outputSize: { height: 1_080, width: 1_920 },
        signal: new AbortController().signal,
      },
      packageId: 'pkg-1',
      session: session as never,
      views: createViews(),
    })

    expect(mocks.createVideoCaptureViewport).toHaveBeenCalledWith(
      session.map,
      { scale: 2_000, targetGeometry: { x: 0, y: 0 } },
      { height: 1_080, width: 1_920 },
      expect.any(AbortSignal),
    )
    const capturedViewpoints = mocks.takeMapOnlyScreenshot.mock.calls.map(
      () => undefined,
    )
    expect(capturedViewpoints).toHaveLength(5)
    expect(captureView.goTo.mock.calls.map(
      ([viewpoint]) => (viewpoint as { json: { scale: number } }).json.scale,
    )).toEqual([
      2_000,
      1_000,
      2_000,
      2_000,
      1_000,
    ])
    const finalTimelineCaptures = await Promise.all(
      mocks.takeMapOnlyScreenshot.mock.results.slice(2).map(
        async (result) => JSON.parse(await (await result.value).text()),
      ),
    )
    expect(finalTimelineCaptures[1].layers).toEqual([
      { id: 'roads', opacity: 0.09999999999999998, visible: true },
      { id: 'labels', opacity: 0.9, visible: true },
    ])
    expect(finalTimelineCaptures[2].layers).toEqual(finalTimelineCaptures[1].layers)
    expect(mocks.composeZoomTimelineFrame).toHaveBeenCalledTimes(2)
    expect(mocks.destroyCaptureViewport).toHaveBeenCalledOnce()
    expect(session.view.goTo).toHaveBeenCalledOnce()
    expect(session.map.allLayers.toArray()).toMatchObject([
      { id: 'roads', opacity: 0.2, visible: false },
      { id: 'labels', opacity: 0.8, visible: true },
    ])
    expect(await completed.thumbnailBlob.text()).toContain('"scale":2000')
    expect(completed).toMatchObject({
      durationMs: 4_000,
      height: 1_080,
      state: 'complete',
      videoMimeType: 'video/webm',
      width: 1_920,
    })
    expect([...frameStoreById.keys()].every((frameId) => !frameId.includes(':transition:'))).toBe(true)
  })

  it('destroys the capture viewport, restores the map, and deletes staging data after failure', async () => {
    const { captureView, session } = createSession()
    mocks.createVideoCaptureViewport.mockResolvedValue({
      destroy: mocks.destroyCaptureViewport,
      view: captureView,
    })
    mocks.takeMapOnlyScreenshot.mockRejectedValueOnce(new Error('frame capture failed'))

    await expect(captureOfflineVideo({
      assets: [],
      options: {
        onProgress: vi.fn(),
        outputSize: { height: 720, width: 1_280 },
        signal: new AbortController().signal,
      },
      packageId: 'pkg-1',
      session: session as never,
      views: createViews(),
    })).rejects.toThrow('frame capture failed')

    expect(mocks.destroyCaptureViewport).toHaveBeenCalledOnce()
    expect(mocks.deletePackage).toHaveBeenCalledWith('pkg-1')
    expect(mocks.encodeVideoFrames).not.toHaveBeenCalled()
    expect(session.view.popup.visible).toBe(true)
    expect(session.map.allLayers.toArray()).toMatchObject([
      { id: 'roads', opacity: 0.2, visible: false },
      { id: 'labels', opacity: 0.8, visible: true },
    ])
  })
})
