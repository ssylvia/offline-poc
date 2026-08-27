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

  class MockStreamTarget {
    readonly writable: WritableStream

    constructor(writable: WritableStream) {
      this.writable = writable
    }
  }

  class MockWebMOutputFormat {
    readonly mimeType: string = 'video/webm'
    readonly options?: unknown

    constructor(options?: unknown) {
      this.options = options
    }
  }

  class MockMp4OutputFormat extends MockWebMOutputFormat {
    override readonly mimeType = 'video/mp4'
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
      if (this.target instanceof MockBufferTarget) {
        this.target.buffer = new Uint8Array([1, 2, 3]).buffer
      }
      this.state = 'finalized'
    })
    readonly options: {
      format: MockWebMOutputFormat
      target: MockBufferTarget | MockStreamTarget
    }
    readonly start = vi.fn(async () => {
      this.state = 'started'
    })

    constructor(options: {
      format: MockWebMOutputFormat
      target: MockBufferTarget | MockStreamTarget
    }) {
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
    Mp4OutputFormat: MockMp4OutputFormat,
    Output: MockOutput,
    Quality: MockQuality,
    StreamTarget: MockStreamTarget,
    WebMOutputFormat: MockWebMOutputFormat,
    canvasSourceInstances,
    getFirstEncodableVideoCodec: vi.fn(),
    outputInstances,
  }
})

vi.mock('mediabunny', () => ({
  BufferTarget: mediabunny.BufferTarget,
  CanvasSource: mediabunny.CanvasSource,
  Mp4OutputFormat: mediabunny.Mp4OutputFormat,
  Output: mediabunny.Output,
  Quality: mediabunny.Quality,
  StreamTarget: mediabunny.StreamTarget,
  WebMOutputFormat: mediabunny.WebMOutputFormat,
  getFirstEncodableVideoCodec: mediabunny.getFirstEncodableVideoCodec,
}))

const storage = vi.hoisted(() => ({
  createPackageWritable: vi.fn(),
  readPackageFile: vi.fn(),
}))

vi.mock('../../../shared/storage/directory.ts', () => ({
  createPackageWritable: storage.createPackageWritable,
  readPackageFile: storage.readPackageFile,
}))

import {
  encodeVideoFrames,
  getSupportedVideoMimeType,
  selectPreferredVideoCodec,
  shouldForceVideoKeyFrame,
} from './video-encoder.ts'
import type { DirectoryPayloadStorage } from '../../../shared/storage/directory.ts'

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
    storage.createPackageWritable.mockReset()
    storage.readPackageFile.mockReset()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('selects broadly playable VP8 before VP9 when choosing an encodable codec', () => {
    expect(selectPreferredVideoCodec(['vp8'])).toBe('vp8')
    expect(selectPreferredVideoCodec(['vp8', 'vp9'])).toBe('vp8')
    expect(selectPreferredVideoCodec(['av1'])).toBeUndefined()
  })

  it('reports the preferred encodable WebM MIME type through Mediabunny', async () => {
    mediabunny.getFirstEncodableVideoCodec.mockResolvedValue('vp8')

    await expect(getSupportedVideoMimeType()).resolves.toBe('video/webm;codecs=vp8')
    expect(mediabunny.getFirstEncodableVideoCodec).toHaveBeenCalledWith(
      ['avc', 'vp8', 'vp9'],
      expect.objectContaining({
        quality: expect.objectContaining({
          options: { bitrate: 5_000_000 },
        }),
      }),
    )
  })

  it('prefers H.264 MP4 when the browser can encode it', async () => {
    mediabunny.getFirstEncodableVideoCodec.mockResolvedValue('avc')

    await expect(getSupportedVideoMimeType()).resolves.toBe(
      'video/mp4;codecs=avc1.42E01E',
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
      { frameRate: 4, maximumPacketCount: 7 },
    )
    expect(mediabunny.canvasSourceInstances[0]?.encodingConfig).toMatchObject({
      codec: 'vp8',
      keyFrameInterval: 1,
      quality: expect.objectContaining({
        options: { bitrate: 5_000_000 },
      }),
    })
    expect(mediabunny.outputInstances[0]?.format.options).toBeUndefined()
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

  it('aborts a folder writable when cancellation happens while it is opening', async () => {
    installCanvasMocks()
    mediabunny.getFirstEncodableVideoCodec.mockResolvedValue('avc')
    const controller = new AbortController()
    const reason = new DOMException('Capture cancelled', 'AbortError')
    const abort = vi.fn(async () => undefined)
    storage.createPackageWritable.mockImplementation(async () => {
      controller.abort(reason)
      return { abort } as never
    })
    const outputStorage = {
      destinationId: 'destination-1',
      directoryName: 'video-package',
      kind: 'directory',
      packageKind: 'offline-video',
    } satisfies DirectoryPayloadStorage

    await expect(encodeVideoFrames({
      frameCount: 2,
      frameRate: 24,
      getFrame: async () => new Blob(['frame'], { type: 'image/png' }),
      height: 720,
      onProgress: vi.fn(),
      outputStorage,
      signal: controller.signal,
      width: 1_280,
    })).rejects.toBe(reason)

    expect(abort).toHaveBeenCalledWith(reason)
    expect(mediabunny.outputInstances).toHaveLength(0)
  })

  it('streams folder-backed output and reads the completed WebM for verification', async () => {
    installCanvasMocks()
    mediabunny.getFirstEncodableVideoCodec.mockResolvedValue('vp9')
    const writable = new WritableStream()
    storage.createPackageWritable.mockResolvedValue(writable)
    storage.readPackageFile.mockResolvedValue(new File(['video'], 'video.webm'))
    const outputStorage = {
      destinationId: 'destination-1',
      directoryName: 'video-package',
      kind: 'directory',
      packageKind: 'offline-video',
    } satisfies DirectoryPayloadStorage

    const result = await encodeVideoFrames({
      frameCount: 1,
      frameRate: 24,
      getFrame: async () => new Blob(['frame'], { type: 'image/png' }),
      height: 720,
      onProgress: vi.fn(),
      outputStorage,
      signal: new AbortController().signal,
      width: 1_280,
    })

    expect(storage.createPackageWritable).toHaveBeenCalledWith(
      outputStorage,
      'video.webm',
    )
    expect(mediabunny.outputInstances[0]?.target).toBeInstanceOf(mediabunny.StreamTarget)
    expect(storage.readPackageFile).toHaveBeenCalledWith(
      outputStorage,
      'video.webm',
    )
    expect(result.blob).toEqual(expect.objectContaining({
      size: 5,
      type: 'video/webm',
    }))
  })

  it('forces keyframes at one-second intervals', () => {
    expect(shouldForceVideoKeyFrame(0, 30)).toBe(true)
    expect(shouldForceVideoKeyFrame(29, 30)).toBe(false)
    expect(shouldForceVideoKeyFrame(30, 30)).toBe(true)
  })
})
