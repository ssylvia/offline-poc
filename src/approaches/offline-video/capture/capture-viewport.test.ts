import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  constructorProperties: undefined as Record<string, unknown> | undefined,
  destroy: vi.fn(),
  mapAtDestroy: undefined as unknown,
  viewpointFromJson: vi.fn((json: unknown) => ({ json })),
  whenOnce: vi.fn(async (predicate: () => boolean) => {
    if (!predicate()) {
      throw new Error('Capture viewport did not reach its configured size.')
    }
  }),
}))

vi.mock('@arcgis/core/Viewpoint.js', () => ({
  default: {
    fromJSON: mocks.viewpointFromJson,
  },
}))

vi.mock('@arcgis/core/core/reactiveUtils.js', () => ({
  whenOnce: mocks.whenOnce,
}))

vi.mock('@arcgis/core/views/MapView.js', () => ({
  default: class MapViewMock {
    container: HTMLDivElement
    height: number
    map: unknown
    resizing = false
    updating = false
    width: number

    constructor(properties: Record<string, unknown>) {
      mocks.constructorProperties = properties
      this.container = properties.container as HTMLDivElement
      this.height = Number.parseInt(this.container.style.height, 10)
      this.map = properties.map
      this.width = Number.parseInt(this.container.style.width, 10)
    }

    destroy() {
      mocks.mapAtDestroy = this.map
      mocks.destroy()
    }

    async when() {
      return this
    }
  },
}))

import { createVideoCaptureViewport } from './capture-viewport.ts'

describe('fixed video capture viewport', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.clearAllMocks()
    mocks.constructorProperties = undefined
    mocks.mapAtDestroy = undefined
  })

  it('creates a reusable offscreen MapView with exact configured dimensions', async () => {
    const map = { id: 'shared-webmap' }
    const controller = new AbortController()
    const viewport = await createVideoCaptureViewport(
      map as never,
      { scale: 4_000, targetGeometry: { x: 1, y: 2 } },
      { height: 1_080, width: 1_920 },
      controller.signal,
    )

    const container = mocks.constructorProperties?.container
    expect(container).toBeInstanceOf(HTMLDivElement)
    expect(container).toHaveStyle({
      height: '1080px',
      left: '-10000px',
      position: 'fixed',
      visibility: 'hidden',
      width: '1920px',
    })
    expect(mocks.constructorProperties).toMatchObject({
      map,
      padding: { bottom: 0, left: 0, right: 0, top: 0 },
      ui: { components: [] },
      viewpoint: {
        json: { scale: 4_000, targetGeometry: { x: 1, y: 2 } },
      },
    })
    expect(mocks.whenOnce).toHaveBeenCalledOnce()

    viewport.destroy()
    expect(mocks.mapAtDestroy).toBeNull()
    expect(mocks.destroy).toHaveBeenCalledOnce()
    expect(document.body).toBeEmptyDOMElement()
  })

  it('does not create a viewport after cancellation', async () => {
    const controller = new AbortController()
    const reason = new DOMException('Cancelled', 'AbortError')
    controller.abort(reason)

    await expect(createVideoCaptureViewport(
      {} as never,
      { scale: 1 },
      { height: 720, width: 1_280 },
      controller.signal,
    )).rejects.toBe(reason)
    expect(mocks.constructorProperties).toBeUndefined()
    expect(document.body).toBeEmptyDOMElement()
  })
})
