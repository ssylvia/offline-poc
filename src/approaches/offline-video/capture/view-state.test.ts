import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyLayerStates,
  createZoomImageFrame,
  crossFadeImageBlobs,
  dataUrlToBlob,
} from './view-state.ts'

describe('offline video view state', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('decodes base64 and percent-encoded screenshot data without fetching', async () => {
    const png = dataUrlToBlob('data:image/png;base64,aGVsbG8=')
    const text = dataUrlToBlob('data:text/plain,hello%20world')

    expect(png.type).toBe('image/png')
    expect(await png.text()).toBe('hello')
    expect(await text.text()).toBe('hello world')
  })

  it('rejects malformed screenshot data URLs', () => {
    expect(() => dataUrlToBlob('https://example.test/frame.png')).toThrow('valid data URL')
    expect(() => dataUrlToBlob('data:image/png;base64,%%%')).toThrow('could not be decoded')
  })

  it('cross-fades two images without rendering intermediate map zooms', async () => {
    const globalAlphaValues: number[] = []
    const drawImage = vi.fn()
    const context = {
      drawImage,
      set globalAlpha(value: number) {
        globalAlphaValues.push(value)
      },
    }
    const canvas = {
      getContext: vi.fn(() => context),
      height: 0,
      toBlob: vi.fn((callback: BlobCallback) => {
        callback(new Blob(['cross-fade'], { type: 'image/png' }))
      }),
      width: 0,
    }
    const bitmaps = [
      { close: vi.fn() },
      { close: vi.fn() },
    ]
    vi.stubGlobal('createImageBitmap', vi.fn()
      .mockResolvedValueOnce(bitmaps[0])
      .mockResolvedValueOnce(bitmaps[1]))
    vi.spyOn(document, 'createElement').mockReturnValue(canvas as never)

    const result = await crossFadeImageBlobs(
      new Blob(['source']),
      new Blob(['destination']),
      { height: 720, width: 1_280 },
      0.25,
    )

    expect(canvas).toMatchObject({ height: 720, width: 1_280 })
    expect(globalAlphaValues).toEqual([1, 0.25])
    expect(drawImage).toHaveBeenCalledTimes(2)
    expect(await result.text()).toBe('cross-fade')
    expect(bitmaps.every((bitmap) => bitmap.close.mock.calls.length === 1)).toBe(true)
  })

  it('expands a source image when zooming in', async () => {
    const drawImage = vi.fn()
    const canvas = {
      getContext: vi.fn(() => ({ drawImage })),
      height: 0,
      toBlob: vi.fn((callback: BlobCallback) => {
        callback(new Blob(['zoom-in'], { type: 'image/png' }))
      }),
      width: 0,
    }
    const bitmap = { close: vi.fn() }
    const createImageBitmapMock = vi.fn().mockResolvedValue(bitmap)
    vi.stubGlobal('createImageBitmap', createImageBitmapMock)
    vi.spyOn(document, 'createElement').mockReturnValue(canvas as never)
    const source = new Blob(['source'])
    const destination = new Blob(['destination'])

    await createZoomImageFrame(
      source,
      destination,
      { height: 600, width: 800 },
      0.5,
      4_000,
      1_000,
    )

    expect(createImageBitmapMock).toHaveBeenCalledWith(source)
    expect(drawImage).toHaveBeenCalledWith(bitmap, -400, -300, 1_600, 1_200)
    expect(bitmap.close).toHaveBeenCalledOnce()
  })

  it('contracts an expanded destination buffer when zooming out', async () => {
    const drawImage = vi.fn()
    const canvas = {
      getContext: vi.fn(() => ({ drawImage })),
      height: 0,
      toBlob: vi.fn((callback: BlobCallback) => {
        callback(new Blob(['zoom-out'], { type: 'image/png' }))
      }),
      width: 0,
    }
    const bitmap = { close: vi.fn() }
    const createImageBitmapMock = vi.fn().mockResolvedValue(bitmap)
    vi.stubGlobal('createImageBitmap', createImageBitmapMock)
    vi.spyOn(document, 'createElement').mockReturnValue(canvas as never)
    const source = new Blob(['source'])
    const destinationBuffer = new Blob(['destination-buffer'])

    await createZoomImageFrame(
      source,
      destinationBuffer,
      { height: 600, width: 800 },
      0.5,
      1_000,
      4_000,
    )

    expect(createImageBitmapMock).toHaveBeenCalledWith(destinationBuffer)
    expect(drawImage).toHaveBeenCalledWith(bitmap, -400, -300, 1_600, 1_200)
    expect(bitmap.close).toHaveBeenCalledOnce()
  })

  it('closes a decoded zoom bitmap when capture is cancelled', async () => {
    const controller = new AbortController()
    const reason = new DOMException('Capture cancelled', 'AbortError')
    const bitmap = { close: vi.fn() }
    vi.stubGlobal('createImageBitmap', vi.fn(async () => {
      controller.abort(reason)
      return bitmap
    }))

    await expect(createZoomImageFrame(
      new Blob(['source']),
      new Blob(['destination']),
      { height: 600, width: 800 },
      0.5,
      4_000,
      1_000,
      controller.signal,
    )).rejects.toBe(reason)

    expect(bitmap.close).toHaveBeenCalledOnce()
  })

  it('validates every captured layer before mutating the map', () => {
    const firstLayer = {
      id: 'layer-1',
      opacity: 0.25,
      title: 'Layer 1',
      visible: false,
    }
    const map = {
      allLayers: {
        toArray: () => [firstLayer],
      },
    }

    expect(() => applyLayerStates(map as never, [
      {
        id: 'layer-1',
        opacity: 1,
        title: 'Layer 1',
        visible: true,
      },
      {
        id: 'missing-layer',
        opacity: 0.5,
        title: 'Missing layer',
        visible: false,
      },
    ])).toThrow('Missing layer')

    expect(firstLayer).toMatchObject({
      opacity: 0.25,
      visible: false,
    })
  })
})
