import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VideoDraftView } from '../types.ts'
import { VideoComposerPanel } from './VideoComposerPanel.tsx'

function createView(id: string, name = id): VideoDraftView {
  return {
    capturedAt: 1,
    extent: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
    id,
    layers: [
      { id: `${id}-visible`, opacity: 1, title: 'Visible layer', visible: true },
      { id: `${id}-hidden`, opacity: 1, title: 'Hidden layer', visible: false },
    ],
    name,
    popup: { anchor: { x: 0.5, y: 0.5 }, attributes: {}, content: [], fallbackReasons: [], location: {}, title: 'Popup' },
    thumbnailBlob: new Blob(['thumb'], { type: 'image/png' }),
    viewpoint: {
      scale: 1,
      targetGeometry: { x: 0, y: 0 },
    },
  }
}

describe('VideoComposerPanel', () => {
  const createObjectUrl = vi.fn(() => 'blob:test')
  const revokeObjectUrl = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: createObjectUrl,
      revokeObjectURL: revokeObjectUrl,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('shows per-view warnings and disables capture controls until the live map is ready', () => {
    render(
      <VideoComposerPanel
        isCapturing={false}
        isReady={false}
        isRecordingView={false}
        onAdd={vi.fn()}
        onCancel={vi.fn()}
        onCapture={vi.fn()}
        onMove={vi.fn()}
        onOutputSizeChange={vi.fn()}
        onRemove={vi.fn()}
        onRename={vi.fn()}
        onUpdate={vi.fn()}
        totalWarningCount={2}
        outputSize={{ height: 1_080, width: 1_920 }}
        views={[createView('view-1', 'Downtown')]}
        warningCountByView={{ 'view-1': 2 }}
      />,
    )

    expect(screen.getByDisplayValue('Downtown')).toBeEnabled()
    expect(screen.getByRole('spinbutton', { name: 'Video width in pixels' })).toBeDisabled()
    expect(screen.getByRole('spinbutton', { name: 'Video height in pixels' })).toBeDisabled()
    expect(screen.getByText(/fixed capture viewport/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add current view' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Create offline video' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Update' })).toBeDisabled()
    expect(screen.getByText('1 visible layers · popup saved · 2 capture warnings')).toBeInTheDocument()
    expect(screen.getByText('2 draft capture warnings will be saved with this video.')).toBeInTheDocument()
  })
})
