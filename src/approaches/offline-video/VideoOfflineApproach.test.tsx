import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UrlState } from '../../app/url-state.ts'
import type { SavedVideoPackage, VideoPackageAsset } from './types.ts'

const mocks = vi.hoisted(() => ({
  deletePackage: vi.fn(),
  getSavedPackage: vi.fn(),
  getStorageEstimate: vi.fn(),
  listAssets: vi.fn(),
  listSavedPackages: vi.fn(),
  removeStaleStagingPackages: vi.fn(),
  requestPersistentStorage: vi.fn(),
  videoCaptureMapLoads: 0,
}))

vi.mock('./storage/database.ts', () => ({
  deletePackage: mocks.deletePackage,
  getSavedPackage: mocks.getSavedPackage,
  getStorageEstimate: mocks.getStorageEstimate,
  listAssets: mocks.listAssets,
  listSavedPackages: mocks.listSavedPackages,
  removeStaleStagingPackages: mocks.removeStaleStagingPackages,
  requestPersistentStorage: mocks.requestPersistentStorage,
}))

vi.mock('./arcgis/VideoCaptureMap.tsx', () => {
  mocks.videoCaptureMapLoads += 1
  return {
    VideoCaptureMap: () => <div>mock video capture map</div>,
  }
})

vi.mock('./ui/OfflineVideoPlayer.tsx', () => ({
  OfflineVideoPlayer: ({
    assets,
    packageRecord,
  }: {
    assets: VideoPackageAsset[]
    packageRecord: SavedVideoPackage
  }) => (
    <div>
      player {packageRecord.packageId} assets {assets.map((asset) => asset.assetId).join(',') || 'none'}
    </div>
  ),
}))

vi.mock('./ui/SavedVideoLibrary.tsx', () => ({
  SavedVideoLibrary: ({ packages }: { packages: SavedVideoPackage[] }) => (
    <div>library {packages.map((entry) => entry.packageId).join(',')}</div>
  ),
}))

vi.mock('./ui/VideoComposerPanel.tsx', () => ({
  VideoComposerPanel: () => <div>composer</div>,
}))

import { VideoOfflineApproach } from './VideoOfflineApproach.tsx'

function createPackage(packageId: string, modified: number): SavedVideoPackage {
  return {
    byteSize: 1_024,
    completedAt: modified,
    createdAt: modified - 1,
    durationMs: 1_000,
    frameRate: 10,
    height: 720,
    item: {
      access: 'public',
      id: 'a'.repeat(32),
      modified,
      owner: 'owner',
      title: 'Shared WebMap',
      type: 'Web Map',
    },
    itemData: {},
    packageId,
    scenes: [],
    schemaVersion: 1,
    state: 'complete',
    thumbnailBlob: new Blob(['thumb'], { type: 'image/png' }),
    videoBlob: new Blob(['video'], { type: 'video/webm' }),
    videoMimeType: 'video/webm',
    warnings: [],
    width: 1_280,
  }
}

function createAsset(packageId: string, assetId: string): VideoPackageAsset {
  return {
    assetId,
    blob: new Blob([assetId], { type: 'image/png' }),
    contentType: 'image/png',
    kind: 'popup-media',
    packageId,
  }
}

function createRoute(savedVideoPackageId: string): UrlState {
  return {
    approachId: 'offline-video',
    mode: 'offline',
    savedVideoPackageId,
    webmapId: 'a'.repeat(32),
  }
}

describe('VideoOfflineApproach', () => {
  beforeEach(() => {
    mocks.videoCaptureMapLoads = 0
    mocks.deletePackage.mockReset()
    mocks.getSavedPackage.mockReset()
    mocks.getStorageEstimate.mockReset().mockResolvedValue({})
    mocks.listAssets.mockReset()
    mocks.listSavedPackages.mockReset()
    mocks.removeStaleStagingPackages.mockReset().mockResolvedValue(undefined)
    mocks.requestPersistentStorage.mockReset().mockResolvedValue(true)
    window.history.replaceState({}, '', '/?approach=offline-video')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens routed saved videos offline without loading the live MapView module', async () => {
    const packages = [createPackage('package-2', 20), createPackage('package-1', 10)]
    mocks.listSavedPackages.mockResolvedValue(packages)
    mocks.getSavedPackage.mockImplementation(async (packageId: string) => (
      packages.find((entry) => entry.packageId === packageId)
    ))
    mocks.listAssets.mockResolvedValue([createAsset('package-1', 'asset-1')])

    render(
      <VideoOfflineApproach
        isOnline={false}
        onNavigate={vi.fn()}
        route={createRoute('package-1')}
      />,
    )

    expect(await screen.findByText('player package-1 assets asset-1')).toBeInTheDocument()
    expect(screen.getByText('library package-2,package-1')).toBeInTheDocument()
    expect(screen.getByText('player package-1 assets asset-1').closest('.workspace')).toHaveClass(
      'workspace-video-explorer',
    )
    expect(screen.queryByText('composer')).not.toBeInTheDocument()
    expect(mocks.videoCaptureMapLoads).toBe(0)
  })

  it('clears stale popup assets while switching between saved packages', async () => {
    const packages = [createPackage('package-2', 20), createPackage('package-1', 10)]
    let resolveSecondAssets: ((value: VideoPackageAsset[]) => void) | undefined
    const secondAssets = new Promise<VideoPackageAsset[]>((resolve) => {
      resolveSecondAssets = resolve
    })
    mocks.listSavedPackages.mockResolvedValue(packages)
    mocks.getSavedPackage.mockImplementation(async (packageId: string) => (
      packages.find((entry) => entry.packageId === packageId)
    ))
    mocks.listAssets.mockImplementation((packageId: string) => {
      if (packageId === 'package-1') {
        return Promise.resolve([createAsset(packageId, 'asset-1')])
      }
      if (packageId === 'package-2') {
        return secondAssets
      }
      return Promise.resolve([])
    })

    const { rerender } = render(
      <VideoOfflineApproach
        isOnline={false}
        onNavigate={vi.fn()}
        route={createRoute('package-1')}
      />,
    )

    expect(await screen.findByText('player package-1 assets asset-1')).toBeInTheDocument()

    rerender(
      <VideoOfflineApproach
        isOnline={false}
        onNavigate={vi.fn()}
        route={createRoute('package-2')}
      />,
    )

    expect(await screen.findByText('player package-2 assets none')).toBeInTheDocument()
    expect(screen.queryByText('player package-2 assets asset-1')).not.toBeInTheDocument()

    await act(async () => {
      resolveSecondAssets?.([createAsset('package-2', 'asset-2')])
      await secondAssets
    })

    await waitFor(() => {
      expect(screen.getByText('player package-2 assets asset-2')).toBeInTheDocument()
    })
  })
})
