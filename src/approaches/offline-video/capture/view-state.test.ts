import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyLayerStates,
  composeZoomTimelineFrame,
  dataUrlToBlob,
  takeMapOnlyScreenshot,
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

  it('captures the exact configured output size instead of deriving it from the view', async () => {
    const takeScreenshot = vi.fn(async () => ({
      dataUrl: 'data:image/png;base64,aGVsbG8=',
    }))
    const view = {
      popup: { visible: true },
      takeScreenshot,
      updating: false,
    }

    const screenshot = await takeMapOnlyScreenshot(
      view as never,
      { height: 1_080, width: 1_920 },
    )

    expect(await screenshot.text()).toBe('hello')
    expect(takeScreenshot).toHaveBeenCalledWith({
      format: 'png',
      height: 1_080,
      width: 1_920,
    })
    expect(view.popup.visible).toBe(true)
  })

  it('reuses a native timeline image without decoding or recompressing it', async () => {
    const source = new Blob(['source'], { type: 'image/png' })
    const createImageBitmapMock = vi.fn()
    vi.stubGlobal('createImageBitmap', createImageBitmapMock)

    await expect(composeZoomTimelineFrame(
      [{ blob: source, imageScale: 1, opacity: 1 }],
      { height: 720, width: 1_280 },
    )).resolves.toBe(source)
    expect(createImageBitmapMock).not.toHaveBeenCalled()
  })

  it('stretches and cross-fades aligned zoom timeline images', async () => {
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
        callback(new Blob(['timeline'], { type: 'image/png' }))
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

    const result = await composeZoomTimelineFrame([
      {
        blob: new Blob(['expanded']),
        imageScale: 1.5,
        opacity: 1,
      },
      {
        blob: new Blob(['next-detail']),
        imageScale: 1,
        opacity: 0.4,
      },
    ], { height: 600, width: 800 })

    expect(canvas).toMatchObject({ height: 600, width: 800 })
    expect(globalAlphaValues).toEqual([1, 0.4])
    expect(drawImage).toHaveBeenNthCalledWith(1, bitmaps[0], -200, -150, 1_200, 900)
    expect(drawImage).toHaveBeenNthCalledWith(2, bitmaps[1], 0, 0, 800, 600)
    expect(await result.text()).toBe('timeline')
    expect(bitmaps.every((bitmap) => bitmap.close.mock.calls.length === 1)).toBe(true)
  })

  it('closes decoded timeline images when capture is cancelled', async () => {
    const controller = new AbortController()
    const reason = new DOMException('Capture cancelled', 'AbortError')
    const bitmap = { close: vi.fn() }
    vi.stubGlobal('createImageBitmap', vi.fn(async () => {
      controller.abort(reason)
      return bitmap
    }))

    await expect(composeZoomTimelineFrame(
      [{ blob: new Blob(['source']), imageScale: 1.25, opacity: 1 }],
      { height: 600, width: 800 },
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
