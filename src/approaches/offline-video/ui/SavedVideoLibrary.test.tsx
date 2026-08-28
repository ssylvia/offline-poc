import { render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedVideoPackage } from '../types.ts'
import { SavedVideoLibrary } from './SavedVideoLibrary.tsx'

function createPackage(packageId: string): SavedVideoPackage {
  return {
    byteSize: 2_048,
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
      title: 'Repeated WebMap',
      type: 'Web Map',
    },
    itemData: {},
    packageId,
    scenes: [],
    schemaVersion: 1,
    state: 'complete',
    thumbnailBlob: new Blob([packageId], { type: 'image/png' }),
    videoBlob: new Blob(['video'], { type: 'video/webm' }),
    videoMimeType: 'video/webm',
    warnings: [],
    width: 1_280,
  }
}

describe('SavedVideoLibrary', () => {
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
  })

  it('shows package identifiers for multiple captures of one WebMap and revokes thumbnail URLs', () => {
    const { unmount } = render(
      <SavedVideoLibrary
        packages={[createPackage('package-1'), createPackage('package-2')]}
        onDelete={vi.fn()}
        onExport={vi.fn()}
        onOpen={vi.fn()}
        onRecapture={vi.fn()}
      />,
    )

    expect(screen.getByText('Package package-1')).toBeInTheDocument()
    expect(screen.getByText('Package package-2')).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: 'Open saved video package package-1 for Repeated WebMap',
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: 'Open saved video package package-2 for Repeated WebMap',
      }),
    ).toBeInTheDocument()

    unmount()
    expect(createObjectURL).toHaveBeenCalledTimes(2)
    expect(revokeObjectURL).toHaveBeenCalledTimes(2)
  })

  it('lists package and view-specific capture warnings', () => {
    const packageRecord = createPackage('package-warning')
    packageRecord.scenes = [{
      holdEndMs: 1_500,
      holdStartMs: 0,
      id: 'scene-1',
      index: 0,
      layers: [],
      name: 'Downtown',
      timestampMs: 750,
      transitionStartMs: 0,
      viewpoint: {},
    }]
    packageRecord.warnings = [{
      code: 'popup-asset-unavailable',
      message: 'The attachment could not be downloaded.',
      viewId: 'scene-1',
    }, {
      code: 'large-capture',
      message: 'Temporary storage exceeded 250 MB.',
    }]

    render(
      <SavedVideoLibrary
        packages={[packageRecord]}
        onDelete={vi.fn()}
        onExport={vi.fn()}
        onOpen={vi.fn()}
        onRecapture={vi.fn()}
      />,
    )

    expect(screen.getByText('View 2 capture warnings')).toBeInTheDocument()
    expect(screen.getByText('View 1: Downtown')).toBeInTheDocument()
    expect(screen.getByText('The attachment could not be downloaded.')).toBeInTheDocument()
    expect(screen.getByText('Package warning')).toBeInTheDocument()
    expect(screen.getByText('Temporary storage exceeded 250 MB.')).toBeInTheDocument()
  })

  it('locks package actions while a capture is running', () => {
    const { container } = render(
      <SavedVideoLibrary
        disabled
        packages={[createPackage('package-busy')]}
        onDelete={vi.fn()}
        onExport={vi.fn()}
        onOpen={vi.fn()}
        onRecapture={vi.fn()}
      />,
    )

    const buttons = within(container).getAllByRole('button')
    expect(buttons).not.toHaveLength(0)
    expect(buttons.every((button) => button.hasAttribute('disabled'))).toBe(true)
  })
})
