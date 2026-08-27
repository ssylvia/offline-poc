import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { SavedMapPackage } from '../types.ts'
import {
  deletePackage,
  finalizePackage,
  getFeatureChunks,
  getLayerSnapshots,
  listSavedPackages,
  putFeatureChunk,
  putLayerSnapshot,
  putPackage,
  removeStaleStagingPackages,
} from './database.ts'

const stagingPackage: SavedMapPackage = {
  byteSize: 1024,
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
  featureCount: 2,
  item: {
    access: 'public',
    id: 'a'.repeat(32),
    modified: 1,
    owner: 'test-owner',
    title: 'Test WebMap',
    type: 'Web Map',
  },
  itemData: {},
  levels: [4, 5, 6],
  packageId: 'test-package',
  resourceCount: 3,
  sdkVersion: 'test',
  state: 'staging',
  viewpoint: {},
  webMapJson: {},
}

describe('offline package persistence', () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: {
        delete: vi.fn().mockResolvedValue(true),
        keys: vi.fn().mockResolvedValue([]),
      },
    })
  })

  it('hides staging data, publishes it atomically, and removes it', async () => {
    await putPackage(stagingPackage)
    await putLayerSnapshot({
      fields: [],
      layerId: 'layer-1',
      layerJson: {},
      objectIdField: 'OBJECTID',
      packageId: stagingPackage.packageId,
      spatialReference: {},
    })
    await putFeatureChunk({
      chunkId: 'chunk-1',
      features: [],
      index: 0,
      layerId: 'layer-1',
      packageId: stagingPackage.packageId,
    })
    expect(await listSavedPackages()).toEqual([])

    const complete = await finalizePackage(stagingPackage)
    expect((await listSavedPackages()).map((entry) => entry.packageId)).toEqual(['test-package'])

    await deletePackage(complete)
    expect(await listSavedPackages()).toEqual([])
    expect(await getLayerSnapshots(stagingPackage.packageId)).toEqual([])
    expect(await getFeatureChunks(stagingPackage.packageId, 'layer-1')).toEqual([])
    expect(caches.delete).toHaveBeenCalledWith('offline-webmap-test')

    await putLayerSnapshot({
      fields: [],
      layerId: 'orphan-layer',
      layerJson: {},
      objectIdField: 'OBJECTID',
      packageId: 'missing-package',
      spatialReference: {},
    })
    await removeStaleStagingPackages()
    expect(await getLayerSnapshots('missing-package')).toEqual([])
  })

  it('cleans stale browser metadata when a package folder is inaccessible', async () => {
    const folderPackage: SavedMapPackage = {
      ...stagingPackage,
      cacheName: 'offline-webmap-folder-test',
      packageId: 'folder-package',
      payloadStorage: {
        destinationId: 'missing-map-destination',
        directoryName: 'stale-map',
        kind: 'directory',
        packageKind: 'interactive-map',
      },
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await putPackage(folderPackage)
    await putLayerSnapshot({
      fields: [],
      layerId: 'folder-layer',
      layerJson: {},
      objectIdField: 'OBJECTID',
      packageId: folderPackage.packageId,
      spatialReference: {},
    })

    await removeStaleStagingPackages()

    expect(warn).toHaveBeenCalledOnce()
    expect(await getLayerSnapshots(folderPackage.packageId)).toEqual([])
  })
})
