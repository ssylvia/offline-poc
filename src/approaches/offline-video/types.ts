import type { JsonObject, PortalItemInfo } from '../../shared/arcgis/index.ts'

export const VIDEO_PACKAGE_SCHEMA_VERSION = 1
export const VIDEO_CAPTURE_FRAME_RATE = 10
export const VIDEO_FINAL_VIEW_HOLD_MS = 1_500

export type VideoPackageState = 'staging' | 'complete'

export interface VideoOutputSize {
  height: number
  width: number
}

export interface CapturedLayerState {
  id: string
  opacity: number
  title: string
  visible: boolean
}

export interface PopupAnchor {
  x: number
  y: number
}

export interface CapturedPopupField {
  fieldName: string
  label: string
  value: string
}

export interface CapturedPopupMediaItem {
  alt?: string
  assetId?: string
  caption?: string
  chartData?: JsonObject
  kind: 'bar-chart' | 'column-chart' | 'image' | 'line-chart' | 'pie-chart' | 'unknown'
  link?: string
  title?: string
}

export interface CapturedPopupAttachment {
  assetId: string
  contentType: string
  name: string
  size: number
}

export interface CapturedRelationshipRecord {
  fields: CapturedPopupField[]
  title: string
}

export type CapturedPopupContent =
  | {
    description?: string
    fields: CapturedPopupField[]
    title?: string
    type: 'fields'
  }
  | {
    html: string
    type: 'html'
  }
  | {
    items: CapturedPopupMediaItem[]
    title?: string
    type: 'media'
  }
  | {
    items: CapturedPopupAttachment[]
    title?: string
    type: 'attachments'
  }
  | {
    records: CapturedRelationshipRecord[]
    title?: string
    type: 'relationship'
  }
  | {
    content: CapturedPopupContent[]
    title?: string
    type: 'expression'
  }
  | {
    assetId: string
    reason: string
    type: 'fallback-image'
  }

export interface CapturedPopup {
  anchor: PopupAnchor
  attributes: JsonObject
  content: CapturedPopupContent[]
  fallbackReasons: string[]
  location: JsonObject
  title: string
}

export interface VideoDraftView {
  capturedAt: number
  extent: JsonObject
  id: string
  layers: CapturedLayerState[]
  name: string
  popup?: CapturedPopup
  thumbnailBlob: Blob
  viewpoint: JsonObject
}

export interface VideoTimelineScene {
  holdEndMs: number
  holdStartMs: number
  id: string
  index: number
  layers: CapturedLayerState[]
  name: string
  popup?: CapturedPopup
  timestampMs: number
  transitionStartMs: number
  viewpoint: JsonObject
}

export type VideoWarningCode =
  | 'large-capture'
  | 'popup-asset-unavailable'
  | 'popup-fallback'

export interface VideoCaptureWarning {
  code: VideoWarningCode
  message: string
  viewId?: string
}

export interface VideoPackageAsset {
  assetId: string
  blob: Blob
  contentType: string
  fileName?: string
  kind: 'attachment' | 'fallback-image' | 'popup-media'
  packageId: string
}

export interface VideoCaptureFrame {
  blob: Blob
  frameId: string
  index: number
  packageId: string
  sceneId?: string
}

export interface SavedVideoPackage {
  byteSize: number
  completedAt?: number
  createdAt: number
  durationMs: number
  frameRate: number
  height: number
  item: PortalItemInfo
  itemData: JsonObject
  packageId: string
  schemaVersion: number
  scenes: VideoTimelineScene[]
  state: VideoPackageState
  thumbnailBlob: Blob
  videoBlob?: Blob
  videoMimeType: string
  warnings: VideoCaptureWarning[]
  width: number
}

export interface ExportedVideoAsset {
  assetId: string
  contentType: string
  dataUrl: string
  fileName?: string
  kind: VideoPackageAsset['kind']
}

export interface VideoExportManifest {
  assets: ExportedVideoAsset[]
  createdAt: number
  durationMs: number
  frameRate: number
  item: PortalItemInfo
  packageId: string
  schemaVersion: number
  scenes: VideoTimelineScene[]
  video: {
    fileName: string
    height: number
    mimeType: string
    width: number
  }
  warnings: VideoCaptureWarning[]
}

export type VideoCapturePhase =
  | 'preparing'
  | 'popups'
  | 'frames'
  | 'encoding'
  | 'verifying'
  | 'complete'

export interface VideoCaptureProgress {
  completed: number
  detail: string
  phase: VideoCapturePhase
  total: number
}

export interface VideoCaptureOptions {
  onProgress: (progress: VideoCaptureProgress) => void
  signal: AbortSignal
}

export interface PopupCaptureResult {
  assets: VideoPackageAsset[]
  popup?: CapturedPopup
  warnings: VideoCaptureWarning[]
}
