import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedMapPackage } from '../types.ts'
import { SavedMapLibrary } from './SavedMapLibrary.tsx'

function createPackage(): SavedMapPackage {
  return {
    byteSize: 2_048,
    compatibility: [{
      id: 'supported-layer',
      level: 'supported',
      message: 'Available offline.',
      title: 'Supported layer',
      type: 'feature',
    }, {
      id: 'imagery-layer',
      level: 'unsupported',
      message: 'Imagery layers are omitted from this snapshot.',
      title: 'Current imagery',
      type: 'imagery',
    }, {
      id: 'vector-layer',
      level: 'degraded',
      message: 'Only common glyph ranges were retained.',
      title: 'Vector labels',
      type: 'vector-tile',
    }],
    cacheName: 'offline-map-test',
    coverageExtent: {
      spatialReference: { wkid: 4326 },
      xmax: 1,
      xmin: 0,
      ymax: 1,
      ymin: 0,
    },
    createdAt: 1,
    featureCount: 10,
    item: {
      access: 'public',
      id: 'a'.repeat(32),
      modified: 1,
      owner: 'owner',
      title: 'Limited offline map',
      type: 'Web Map',
    },
    itemData: {},
    levels: [4],
    packageId: 'map-package',
    resourceCount: 3,
    sdkVersion: 'test',
    state: 'complete',
    viewpoint: {},
    webMapJson: {},
  }
}

describe('SavedMapLibrary', () => {
  beforeEach(() => {
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:thumbnail'),
      revokeObjectURL: vi.fn(),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('lists each known limitation for a saved map', () => {
    render(
      <SavedMapLibrary
        packages={[createPackage()]}
        onDelete={vi.fn()}
        onOpen={vi.fn()}
        onUpdate={vi.fn()}
      />,
    )

    expect(screen.getByText('View 2 known offline limitations')).toBeInTheDocument()
    expect(screen.getByText('Current imagery')).toBeInTheDocument()
    expect(screen.getByText('Imagery layers are omitted from this snapshot.')).toBeInTheDocument()
    expect(screen.getByText('Vector labels')).toBeInTheDocument()
    expect(screen.getByText('Only common glyph ranges were retained.')).toBeInTheDocument()
    expect(screen.queryByText('Supported layer')).not.toBeInTheDocument()
  })
})
