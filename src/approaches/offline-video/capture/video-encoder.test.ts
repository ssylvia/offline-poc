import { afterEach, describe, expect, it, vi } from 'vitest'

const mediabunny = vi.hoisted(() => {
  const canvasSourceInstances: MockCanvasSource[] = []
  const outputInstances: MockOutput[] = []

  class MockQuality {
    readonly options: unknown

    constructor(options: unknown) {
      this.options = options
    }
  }

  class MockBufferTarget {
    buffer: ArrayBuffer | null = null
  }

  class MockWebMOutputFormat {
    readonly mimeType = 'video/webm'
    readonly options?: unknown

    constructor(options?: unknown) {
      this.options = options
    }
  }

  class MockCanvasSource {
    readonly add = vi.fn(async () => undefined)
    readonly canvas: HTMLCanvasElement
    readonly close = vi.fn()
    readonly encodingConfig: unknown

    constructor(canvas: HTMLCanvasElement, encodingConfig: unknown) {
      this.canvas = canvas
      this.encodingConfig = encodingConfig
      canvasSourceInstances.push(this)
    }
  }

  class MockOutput {
    state: 'pending' | 'started' | 'canceled' | 'finalizing' | 'finalized' = 'pending'
    readonly addVideoTrack = vi.fn()
    readonly cancel = vi.fn(async () => {
      this.state = 'canceled'
    })
    readonly finalize = vi.fn(async () => {
      this.state = 'finalizing'
      this.target.buffer = new Uint8Array([1, 2, 3]).buffer
      this.state = 'finalized'
    })
    readonly options: { format: MockWebMOutputFormat; target: MockBufferTarget }
    readonly start = vi.fn(async () => {
      this.state = 'started'
    })

    constructor(options: { format: MockWebMOutputFormat; target: MockBufferTarget }) {
      this.options = options
      outputInstances.push(this)
    }

    get format() {
      return this.options.format
    }

    get target() {
      return this.options.target
    }
  }

  return {
    BufferTarget: MockBufferTarget,
    CanvasSource: MockCanvasSource,
    Output: MockOutput,
    Quality: MockQuality,
    WebMOutputFormat: MockWebMOutputFormat,
    canvasSourceInstances,
    getFirstEncodableVideoCodec: vi.fn(),
    outputInstances,
  }
})

vi.mock('mediabunny', () => ({
  BufferTarget: mediabunny.BufferTarget,
  CanvasSource: mediabunny.CanvasSource,
  Output: mediabunny.Output,
  Quality: mediabunny.Quality,
  WebMOutputFormat: mediabunny.WebMOutputFormat,
  getFirstEncodableVideoCodec: mediabunny.getFirstEncodableVideoCodec,
}))

import {
  encodeVideoFrames,
  getSupportedVideoMimeType,
  selectPreferredVideoCodec,
  shouldForceVideoKeyFrame,
} from './video-encoder.ts'

function installCanvasMocks() {
  const context = {
    drawImage: vi.fn(),
  }
  const canvas = {
    getContext: vi.fn(() => context),
    height: 0,
    width: 0,
  }
  const bitmaps: Array<{ close: ReturnType<typeof vi.fn> }> = []
  const originalCreateElement = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
    if (tagName === 'canvas') {
      return canvas as unknown as HTMLCanvasElement
    }
    return originalCreateElement(tagName)
  }) as typeof document.createElement)
  vi.stubGlobal('createImageBitmap', vi.fn(async () => {
    const bitmap = { close: vi.fn() }
    bitmaps.push(bitmap)
    return bitmap as unknown as ImageBitmap
  }))

  return { bitmaps, canvas, context }
}

describe('offline video encoder', () => {
  afterEach(() => {
    mediabunny.canvasSourceInstances.length = 0
    mediabunny.getFirstEncodableVideoCodec.mockReset()
    mediabunny.outputInstances.length = 0
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('selects VP9 before VP8 when choosing an encodable codec', () => {
    expect(selectPreferredVideoCodec(['vp8'])).toBe('vp8')
    expect(selectPreferredVideoCodec(['vp8', 'vp9'])).toBe('vp9')
    expect(selectPreferredVideoCodec(['av1'])).toBeUndefined()
  })

  it('reports the preferred encodable WebM MIME type through Mediabunny', async () => {
    mediabunny.getFirstEncodableVideoCodec.mockResolvedValue('vp8')

    await expect(getSupportedVideoMimeType()).resolves.toBe('video/webm;codecs=vp8')
    expect(mediabunny.getFirstEncodableVideoCodec).toHaveBeenCalledWith(
      ['vp9', 'vp8'],
      expect.objectContaining({
        quality: expect.objectContaining({
          options: { bitrate: 5_000_000 },
        }),
      }),
    )
  })

  it('draws staged frames with deterministic timing and finalizes a seekable WebM', async () => {
    const { bitmaps, canvas, context } = installCanvasMocks()
    mediabunny.getFirstEncodableVideoCodec.mockResolvedValue('vp8')
    const progress = vi.fn()

    const result = await encodeVideoFrames({
      frameCount: 5,
      frameRate: 4,
      getFrame: async (index) => new Blob([`frame-${index}`], { type: 'image/png' }),
      height: 720,
      onProgress: progress,
      signal: new AbortController().signal,
      width: 1_280,
    })

    expect(canvas.width).toBe(1_280)
    expect(canvas.height).toBe(720)
    expect(context.drawImage).toHaveBeenCalledTimes(5)
    expect(mediabunny.outputInstances).toHaveLength(1)
    expect(mediabunny.canvasSourceInstances).toHaveLength(1)
    expect(mediabunny.outputInstances[0]?.addVideoTrack).toHaveBeenCalledWith(
      mediabunny.canvasSourceInstances[0],
      { frameRate: 4, maximumPacketCount: 5 },
    )
    expect(mediabunny.canvasSourceInstances[0]?.encodingConfig).toMatchObject({
      codec: 'vp8',
      keyFrameInterval: 1,
      quality: expect.objectContaining({
        options: { bitrate: 5_000_000 },
      }),
    })
    expect(mediabunny.outputInstances[0]?.format.options).toEqual({
      appendOnly: false,
      minimumClusterDuration: 1,
    })
    expect(mediabunny.canvasSourceInstances[0]?.add.mock.calls).toEqual([
      [0, 0.25, { keyFrame: true }],
      [0.25, 0.25, undefined],
      [0.5, 0.25, undefined],
      [0.75, 0.25, undefined],
      [1, 0.25, { keyFrame: true }],
    ])
    expect(mediabunny.canvasSourceInstances[0]?.close).toHaveBeenCalledTimes(1)
    expect(mediabunny.outputInstances[0]?.finalize).toHaveBeenCalledTimes(1)
    expect(mediabunny.outputInstances[0]?.cancel).not.toHaveBeenCalled()
    expect(progress).toHaveBeenCalledTimes(5)
    expect(bitmaps.map((bitmap) => bitmap.close.mock.calls.length)).toEqual([1, 1, 1, 1, 1])
    expect(result.mimeType).toBe('video/webm')
    expect(result.blob.type).toBe('video/webm')
    expect(result.blob.size).toBeGreaterThan(0)
  })

  it('cancels the muxer when encoding is aborted', async () => {
    installCanvasMocks()
    mediabunny.getFirstEncodableVideoCodec.mockResolvedValue('vp9')
    const controller = new AbortController()
    const reason = new DOMException('Capture cancelled', 'AbortError')

    await expect(encodeVideoFrames({
      frameCount: 2,
      frameRate: 10,
      getFrame: async () => new Blob(['frame'], { type: 'image/png' }),
      height: 720,
      onProgress: () => controller.abort(reason),
      signal: controller.signal,
      width: 1_280,
    })).rejects.toBe(reason)

    expect(mediabunny.canvasSourceInstances).toHaveLength(1)
    expect(mediabunny.outputInstances).toHaveLength(1)
    expect(mediabunny.canvasSourceInstances[0]?.close).toHaveBeenCalledTimes(1)
    expect(mediabunny.outputInstances[0]?.cancel).toHaveBeenCalledTimes(1)
    expect(mediabunny.outputInstances[0]?.finalize).not.toHaveBeenCalled()
  })

  it('forces keyframes at one-second intervals', () => {
    expect(shouldForceVideoKeyFrame(0, 30)).toBe(true)
    expect(shouldForceVideoKeyFrame(29, 30)).toBe(false)
    expect(shouldForceVideoKeyFrame(30, 30)).toBe(true)
  })
})
