import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedMapPackage } from '../types.ts'

const mocks = vi.hoisted(() => ({
  activatePackageCache: vi.fn(),
  buildOfflineWebMap: vi.fn(),
  deactivatePackageCache: vi.fn(),
}))

vi.mock('@arcgis/core/geometry/Extent.js', () => ({
  default: { fromJSON: vi.fn() },
}))

vi.mock('@arcgis/core/Viewpoint.js', () => ({
  default: { fromJSON: vi.fn() },
}))

vi.mock('@arcgis/core/views/MapView.js', () => ({
  default: vi.fn(),
}))

vi.mock('@arcgis/core/core/reactiveUtils.js', () => ({
  watch: vi.fn(),
}))

vi.mock('../storage/service-worker-client.ts', () => ({
  activatePackageCache: mocks.activatePackageCache,
  deactivatePackageCache: mocks.deactivatePackageCache,
}))

vi.mock('./offline-map-builder.ts', () => ({
  buildOfflineWebMap: mocks.buildOfflineWebMap,
}))

import { OfflineMap } from './OfflineMap.tsx'

const packageRecord: SavedMapPackage = {
  byteSize: 1_024,
  cacheName: 'offline-webmap-test',
  compatibility: [],
  coverageExtent: {
    xmin: 0,
    ymin: 0,
    xmax: 1,
    ymax: 1,
    spatialReference: { wkid: 4326 },
  },
  createdAt: 1,
  featureCount: 1,
  item: {
    access: 'public',
    id: 'a'.repeat(32),
    modified: 1,
    owner: 'test-owner',
    title: 'Test WebMap',
    type: 'Web Map',
  },
  itemData: {},
  levels: [4],
  packageId: 'test-package',
  resourceCount: 0,
  sdkVersion: 'test',
  state: 'complete',
  viewpoint: {},
  webMapJson: {},
}

describe('OfflineMap', () => {
  beforeEach(() => {
    mocks.activatePackageCache.mockReset().mockResolvedValue(undefined)
    mocks.buildOfflineWebMap.mockReset()
    mocks.deactivatePackageCache.mockReset()
  })

  it('releases the active package cache when reconstruction fails', async () => {
    mocks.buildOfflineWebMap.mockRejectedValue(new Error('Stored map data is corrupt'))
    const onError = vi.fn()

    const rendered = render(
      <OfflineMap
        onCoverageChange={vi.fn()}
        onError={onError}
        packageRecord={packageRecord}
      />,
    )

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith('Stored map data is corrupt')
    })
    expect(mocks.activatePackageCache).toHaveBeenCalledWith(packageRecord)
    expect(mocks.deactivatePackageCache).toHaveBeenCalledOnce()
    expect(screen.queryByRole('status')).toBeNull()

    rendered.unmount()
    expect(mocks.deactivatePackageCache).toHaveBeenCalledOnce()
  })

  it('deactivates a cache that finishes activating after unmount', async () => {
    let finishActivation: (() => void) | undefined
    mocks.activatePackageCache.mockReturnValue(new Promise<void>((resolve) => {
      finishActivation = resolve
    }))

    const rendered = render(
      <OfflineMap
        onCoverageChange={vi.fn()}
        onError={vi.fn()}
        packageRecord={packageRecord}
      />,
    )
    rendered.unmount()

    await act(async () => {
      finishActivation?.()
    })

    await waitFor(() => {
      expect(mocks.deactivatePackageCache).toHaveBeenCalledOnce()
    })
    expect(mocks.buildOfflineWebMap).not.toHaveBeenCalled()
  })
})
