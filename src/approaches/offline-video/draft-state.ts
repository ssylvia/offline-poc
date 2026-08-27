import type {
  PopupCaptureResult,
  VideoCaptureWarning,
  VideoDraftView,
  VideoPackageAsset,
} from './types.ts'

export interface DraftViewArtifacts {
  assets: VideoPackageAsset[]
  warnings: VideoCaptureWarning[]
}

export type DraftArtifactsByView = Record<string, DraftViewArtifacts>

function dedupeAssets(assets: VideoPackageAsset[]): VideoPackageAsset[] {
  const deduped = new Map<string, VideoPackageAsset>()
  for (const asset of assets) {
    deduped.set(asset.assetId, asset)
  }
  return [...deduped.values()]
}

function dedupeWarnings(warnings: VideoCaptureWarning[]): VideoCaptureWarning[] {
  const deduped = new Map<string, VideoCaptureWarning>()
  for (const warning of warnings) {
    deduped.set(
      `${warning.viewId ?? ''}\u0000${warning.code}\u0000${warning.message}`,
      warning,
    )
  }
  return [...deduped.values()]
}

export function upsertDraftArtifacts(
  state: DraftArtifactsByView,
  viewId: string,
  result: Pick<PopupCaptureResult, 'assets' | 'warnings'>,
): DraftArtifactsByView {
  return {
    ...state,
    [viewId]: {
      assets: dedupeAssets(result.assets),
      warnings: dedupeWarnings(result.warnings.map((warning) => (
        warning.viewId ? warning : { ...warning, viewId }
      ))),
    },
  }
}

export function removeDraftArtifacts(
  state: DraftArtifactsByView,
  viewId: string,
): DraftArtifactsByView {
  const { [viewId]: _removed, ...remaining } = state
  return remaining
}

export function listDraftAssets(
  views: Array<Pick<VideoDraftView, 'id'>>,
  state: DraftArtifactsByView,
): VideoPackageAsset[] {
  const deduped = new Map<string, VideoPackageAsset>()
  for (const view of views) {
    for (const asset of state[view.id]?.assets ?? []) {
      if (!deduped.has(asset.assetId)) {
        deduped.set(asset.assetId, asset)
      }
    }
  }
  return [...deduped.values()]
}

export function listDraftWarnings(
  views: Array<Pick<VideoDraftView, 'id'>>,
  state: DraftArtifactsByView,
): VideoCaptureWarning[] {
  const deduped = new Map<string, VideoCaptureWarning>()
  for (const view of views) {
    for (const warning of state[view.id]?.warnings ?? []) {
      const key = `${warning.viewId ?? view.id}\u0000${warning.code}\u0000${warning.message}`
      if (!deduped.has(key)) {
        deduped.set(key, warning.viewId ? warning : { ...warning, viewId: view.id })
      }
    }
  }
  return [...deduped.values()]
}

export function countDraftWarningsByView(state: DraftArtifactsByView): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const [viewId, entry] of Object.entries(state)) {
    counts[viewId] = dedupeWarnings(entry.warnings).length
  }
  return counts
}
