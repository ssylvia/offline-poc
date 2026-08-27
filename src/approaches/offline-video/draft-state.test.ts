import { describe, expect, it } from 'vitest'
import {
  countDraftWarningsByView,
  listDraftAssets,
  listDraftWarnings,
  removeDraftArtifacts,
  upsertDraftArtifacts,
  type DraftArtifactsByView,
} from './draft-state.ts'
import type { VideoCaptureWarning, VideoDraftView, VideoPackageAsset } from './types.ts'

function createAsset(assetId: string): VideoPackageAsset {
  return {
    assetId,
    blob: new Blob([assetId], { type: 'image/png' }),
    contentType: 'image/png',
    kind: 'popup-media',
    packageId: 'draft',
  }
}

function createWarning(
  code: VideoCaptureWarning['code'],
  message: string,
  viewId?: string,
): VideoCaptureWarning {
  return { code, message, viewId }
}

function createView(id: string): VideoDraftView {
  return {
    capturedAt: 1,
    extent: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
    id,
    layers: [],
    name: id,
    thumbnailBlob: new Blob([id], { type: 'image/png' }),
    viewpoint: {
      scale: 1,
      targetGeometry: { x: 0, y: 0 },
    },
  }
}

describe('offline video draft state', () => {
  it('tracks per-view assets and warnings in view order', () => {
    let state: DraftArtifactsByView = {}
    state = upsertDraftArtifacts(state, 'view-1', {
      assets: [createAsset('asset-1'), createAsset('asset-1')],
      warnings: [createWarning('popup-fallback', 'Fallback used')],
    })
    state = upsertDraftArtifacts(state, 'view-2', {
      assets: [createAsset('asset-2')],
      warnings: [
        createWarning('popup-asset-unavailable', 'Asset missing', 'view-2'),
        createWarning('popup-asset-unavailable', 'Asset missing', 'view-2'),
      ],
    })

    expect(listDraftAssets([createView('view-2'), createView('view-1')], state).map((asset) => asset.assetId)).toEqual([
      'asset-2',
      'asset-1',
    ])
    expect(listDraftWarnings([createView('view-1'), createView('view-2')], state)).toEqual([
      createWarning('popup-fallback', 'Fallback used', 'view-1'),
      createWarning('popup-asset-unavailable', 'Asset missing', 'view-2'),
    ])
    expect(countDraftWarningsByView(state)).toEqual({
      'view-1': 1,
      'view-2': 1,
    })
  })

  it('removes stale per-view artifacts when a draft view is deleted', () => {
    const state = removeDraftArtifacts(upsertDraftArtifacts({}, 'view-1', {
      assets: [createAsset('asset-1')],
      warnings: [createWarning('popup-fallback', 'Fallback used')],
    }), 'view-1')

    expect(listDraftAssets([createView('view-1')], state)).toEqual([])
    expect(listDraftWarnings([createView('view-1')], state)).toEqual([])
  })
})
