import { render, screen } from '@testing-library/react'
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
})
