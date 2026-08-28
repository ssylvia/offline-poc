import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedVideoPackage, VideoPackageAsset } from '../types.ts'
import { OfflineVideoPlayer } from './OfflineVideoPlayer.tsx'

let resizeObserverCallback: (() => void) | undefined
let currentTimeSeconds = 0
const originalCurrentTime = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')

class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverCallback = () => callback([], this as never)
  }

  disconnect() {}

  observe() {}

  unobserve() {}
}

function createPackage(): SavedVideoPackage {
  return {
    byteSize: 1_024,
    createdAt: 1,
    durationMs: 1_000,
    frameRate: 24,
    height: 900,
    item: {
      access: 'public',
      id: 'a'.repeat(32),
      modified: 1,
      owner: 'owner',
      title: 'Accessible popup tour',
      type: 'Web Map',
    },
    itemData: {},
    packageId: 'package-1',
    scenes: [{
      holdEndMs: 400,
      holdStartMs: 100,
      id: 'scene-1',
      index: 0,
      layers: [],
      name: 'Downtown',
      popup: {
        anchor: { x: 0.75, y: 0.25 },
        attributes: {},
        content: [
          {
            description: 'Overview <strong>details</strong>',
            fields: [{
              fieldName: 'status',
              label: 'Status',
              value: 'Ready',
            }],
            title: '<em>Stats</em>',
            type: 'fields',
          },
          {
            html: '<p>Custom <strong>HTML</strong></p>',
            type: 'html',
          },
          {
            items: [
              {
                alt: '<i>Tree</i>',
                assetId: 'media-1',
                caption: '<i>Caption</i>',
                kind: 'image',
                link: 'https://example.test/details',
                title: '<b>Photo</b>',
              },
              {
                chartData: { count: 12, total: 100 },
                kind: 'pie-chart',
                title: 'Totals',
              },
            ],
            title: 'Media',
            type: 'media',
          },
          {
            items: [{
              assetId: 'attachment-1',
              contentType: 'application/pdf',
              name: 'report.pdf',
              size: 2_048,
            }],
            title: 'Files',
            type: 'attachments',
          },
          {
            records: [{
              fields: [{
                fieldName: 'name',
                label: 'Name',
                value: 'Pump Station',
              }],
              title: '<i>Pump Station</i>',
            }],
            title: '<b>Related</b>',
            type: 'relationship',
          },
          {
            content: [{
              html: '<span>Nested</span>',
              type: 'html',
            }],
            title: 'Expression',
            type: 'expression',
          },
          {
            assetId: 'fallback-1',
            reason: 'Unsafe popup DOM content.',
            type: 'fallback-image',
          },
        ],
        fallbackReasons: ['Unsafe popup DOM content.'],
        location: {},
        title: '<strong>Pop up title</strong>',
      },
      timestampMs: 200,
      transitionStartMs: 0,
      viewpoint: {},
    }, {
      holdEndMs: 900,
      holdStartMs: 650,
      id: 'scene-2',
      index: 1,
      layers: [],
      name: 'Harbor',
      popup: {
        anchor: { x: 0.2, y: 0.2 },
        attributes: {},
        content: [{
          html: '<p>Second popup</p>',
          type: 'html',
        }],
        fallbackReasons: [],
        location: {},
        title: 'Harbor popup',
      },
      timestampMs: 700,
      transitionStartMs: 400,
      viewpoint: {},
    }],
    schemaVersion: 1,
    state: 'complete',
    thumbnailBlob: new Blob(['thumb'], { type: 'image/png' }),
    videoBlob: new Blob(['video'], { type: 'video/webm' }),
    videoMimeType: 'video/webm',
    warnings: [],
    width: 1_600,
  }
}

function createAssets(): VideoPackageAsset[] {
  return [
    {
      assetId: 'attachment-1',
      blob: new Blob(['attachment'], { type: 'application/pdf' }),
      contentType: 'application/pdf',
      kind: 'attachment',
      packageId: 'package-1',
    },
    {
      assetId: 'fallback-1',
      blob: new Blob(['fallback'], { type: 'image/png' }),
      contentType: 'image/png',
      kind: 'fallback-image',
      packageId: 'package-1',
    },
    {
      assetId: 'media-1',
      blob: new Blob(['media'], { type: 'image/png' }),
      contentType: 'image/png',
      kind: 'popup-media',
      packageId: 'package-1',
    },
  ]
}

function setStageSize(container: HTMLElement, width: number, height: number) {
  const stage = container.querySelector('.offline-video-stage')
  if (!(stage instanceof HTMLDivElement)) {
    throw new Error('offline video stage not found')
  }
  Object.defineProperty(stage, 'clientWidth', { configurable: true, value: width })
  Object.defineProperty(stage, 'clientHeight', { configurable: true, value: height })
  act(() => resizeObserverCallback?.())
}

describe('OfflineVideoPlayer', () => {
  const createObjectURL = vi.fn()
  const revokeObjectURL = vi.fn()

  beforeEach(() => {
    let nextUrlId = 0
    currentTimeSeconds = 0
    createObjectURL.mockReset()
    createObjectURL.mockImplementation(() => `blob:${++nextUrlId}`)
    revokeObjectURL.mockReset()
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    })
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      configurable: true,
      get() {
        return currentTimeSeconds
      },
      set(value: number) {
        currentTimeSeconds = value
      },
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    if (originalCurrentTime) {
      Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', originalCurrentTime)
    }
  })

  it('renders accessible popup content inside the letterboxed video area and hides it outside hold windows', () => {
    const { container } = render(
      <OfflineVideoPlayer
        assets={createAssets()}
        onError={vi.fn()}
        packageRecord={createPackage()}
      />,
    )
    setStageSize(container, 1_000, 1_000)

    const video = screen.getByLabelText('Accessible popup tour offline video')
    expect(video).not.toHaveAttribute('controls')
    currentTimeSeconds = 0.2
    fireEvent.timeUpdate(video)

    expect(screen.getByRole('dialog', { name: 'Pop up title' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Stats' })).toBeInTheDocument()
    expect(screen.getByText((_, node) => node?.tagName === 'P' && node.textContent === 'Overview details')).toBeInTheDocument()
    expect(screen.getByText((_, node) => node?.tagName === 'P' && node.textContent === 'Custom HTML')).toBeInTheDocument()
    expect(screen.getByAltText('Tree')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open media source' })).toHaveAttribute(
      'href',
      'https://example.test/details',
    )
    expect(screen.getByRole('img', { name: /Totals\. Chart data:/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'report.pdf' })).toBeInTheDocument()
    expect(screen.getByText('application/pdf · 2.0 KB')).toBeInTheDocument()
    expect(screen.getAllByText('Pump Station')).toHaveLength(2)
    expect(screen.getByText('Nested')).toBeInTheDocument()
    expect(screen.getByAltText('Popup fallback image. Unsafe popup DOM content.')).toBeInTheDocument()
    expect(screen.getByText('View 1 of 2: Downtown')).toBeInTheDocument()

    const popupAnchor = container.querySelector('.video-popup-anchor')
    expect(popupAnchor).toHaveStyle({ left: '750px', top: '359.375px' })

    currentTimeSeconds = 0.45
    fireEvent.timeUpdate(video)
    expect(screen.queryByRole('dialog', { name: 'Pop up title' })).not.toBeInTheDocument()

    currentTimeSeconds = 0.2
    fireEvent.timeUpdate(video)
    expect(screen.getByRole('dialog', { name: 'Pop up title' })).toBeInTheDocument()

    fireEvent.ended(video)
    expect(screen.queryByRole('dialog', { name: 'Pop up title' })).not.toBeInTheDocument()
  })

  it('plays forward to the next stop and seeks backward to a previous stop', () => {
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const { unmount } = render(
      <OfflineVideoPlayer
        assets={createAssets()}
        onError={vi.fn()}
        packageRecord={createPackage()}
      />,
    )

    const video = screen.getByLabelText('Accessible popup tour offline video')

    currentTimeSeconds = 0.2
    fireEvent.timeUpdate(video)

    fireEvent.click(screen.getByRole('button', { name: 'Go to the next captured view' }))
    expect(playSpy).toHaveBeenCalledOnce()
    expect(currentTimeSeconds).toBe(0.4)
    expect(screen.getByText('Moving to view 2: Harbor')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Pop up title' })).not.toBeInTheDocument()

    currentTimeSeconds = 0.66
    fireEvent.timeUpdate(video)
    expect(currentTimeSeconds).toBe(0.7)
    expect(pauseSpy).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Go to view 2: Harbor' })).toHaveAttribute('aria-current', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Go to the previous captured view' }))
    expect(currentTimeSeconds).toBe(0.2)
    expect(screen.getByRole('button', { name: 'Go to view 1: Downtown' })).toHaveAttribute('aria-current', 'true')

    unmount()
    expect(createObjectURL).toHaveBeenCalledTimes(4)
    expect(revokeObjectURL).toHaveBeenCalledTimes(4)
  })

  it('skips intermediate view holds and keeps popups hidden during multi-view navigation', () => {
    const packageRecord = createPackage()
    packageRecord.durationMs = 1_600
    packageRecord.scenes.push({
      holdEndMs: 1_500,
      holdStartMs: 1_200,
      id: 'scene-3',
      index: 2,
      layers: [],
      name: 'Airport',
      timestampMs: 1_300,
      transitionStartMs: 900,
      viewpoint: {},
    })
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    render(
      <OfflineVideoPlayer
        assets={createAssets()}
        onError={vi.fn()}
        packageRecord={packageRecord}
      />,
    )
    const video = screen.getByLabelText('Accessible popup tour offline video')
    currentTimeSeconds = 0.2
    fireEvent.timeUpdate(video)

    fireEvent.click(screen.getByRole('button', { name: 'Go to view 3: Airport' }))
    expect(playSpy).toHaveBeenCalledOnce()
    expect(currentTimeSeconds).toBe(0.4)
    expect(screen.queryByRole('dialog', { name: 'Pop up title' })).not.toBeInTheDocument()

    currentTimeSeconds = 0.7
    fireEvent.timeUpdate(video)
    expect(currentTimeSeconds).toBe(0.9)
    expect(screen.queryByRole('dialog', { name: 'Harbor popup' })).not.toBeInTheDocument()

    currentTimeSeconds = 1.21
    fireEvent.timeUpdate(video)
    expect(currentTimeSeconds).toBe(1.3)
    expect(screen.getByText('View 3 of 3: Airport')).toBeInTheDocument()
  })

  it('recreates object URLs after Strict Mode cleanup instead of using a revoked video URL', () => {
    render(
      <StrictMode>
        <OfflineVideoPlayer
          assets={createAssets()}
          onError={vi.fn()}
          packageRecord={createPackage()}
        />
      </StrictMode>,
    )

    const video = screen.getByLabelText('Accessible popup tour offline video')
    const activeUrl = video.getAttribute('src')
    const revokedUrls = new Set(revokeObjectURL.mock.calls.map(([url]) => url))

    expect(activeUrl).toMatch(/^blob:/)
    expect(revokedUrls.has(activeUrl)).toBe(false)
  })
})
