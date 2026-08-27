import type Extent from '@arcgis/core/geometry/Extent.js'
import type Layer from '@arcgis/core/layers/Layer.js'
import {
  serializeArcGisJson,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
  type LiveMapSession,
  type PortalItemInfo,
} from '../../shared/arcgis/index.ts'

export { serializeArcGisJson }
export type { JsonObject, JsonPrimitive, JsonValue, LiveMapSession, PortalItemInfo }

export interface SerializedSpatialReference {
  latestWkid?: number
  wkid?: number
  wkt?: string
}

export interface SerializedExtent {
  spatialReference: SerializedSpatialReference
  xmax: number
  xmin: number
  ymax: number
  ymin: number
}

export type CompatibilityLevel = 'supported' | 'degraded' | 'unsupported'

export interface LayerCompatibility {
  featureCount?: number
  id: string
  level: CompatibilityLevel
  message: string
  resourceCount?: number
  title: string
  type: string
}

export interface TileResource {
  layerId: string
  level?: number
  url: string
}

export interface FeatureDownloadPlan {
  featureCount: number
  layer: Layer
  layerId: string
  title: string
}

export interface PreflightReport {
  coverageExtent: SerializedExtent
  estimatedBytes: number
  featurePlans: FeatureDownloadPlan[]
  generatedAt: number
  hasLimitations: boolean
  layerResults: LayerCompatibility[]
  levels: number[]
  resourceUrls: TileResource[]
}

export type PackageState = 'staging' | 'complete'

export interface SavedMapPackage {
  byteSize: number
  cacheName: string
  compatibility: LayerCompatibility[]
  completedAt?: number
  coverageExtent: SerializedExtent
  createdAt: number
  featureCount: number
  item: PortalItemInfo
  itemData: JsonObject
  levels: number[]
  packageId: string
  resourceCount: number
  sdkVersion: string
  state: PackageState
  thumbnailBlob?: Blob
  viewpoint: JsonObject
  webMapJson: JsonObject
}

export interface FeatureLayerSnapshot {
  fields: JsonObject[]
  geometryType?: string
  layerId: string
  layerJson: JsonObject
  objectIdField: string
  packageId: string
  spatialReference: JsonObject
}

export interface FeatureChunk {
  chunkId: string
  features: JsonObject[]
  index: number
  layerId: string
  packageId: string
}

export type DownloadPhase =
  | 'preparing'
  | 'features'
  | 'resources'
  | 'verifying'
  | 'complete'

export interface DownloadProgress {
  completed: number
  detail: string
  phase: DownloadPhase
  total: number
}

export interface DownloadOptions {
  allowDegraded: boolean
  onProgress: (progress: DownloadProgress) => void
  signal: AbortSignal
}

export function serializeExtent(extent: Extent): SerializedExtent {
  return {
    xmin: extent.xmin,
    ymin: extent.ymin,
    xmax: extent.xmax,
    ymax: extent.ymax,
    spatialReference: {
      wkid: extent.spatialReference.wkid ?? undefined,
      latestWkid: extent.spatialReference.latestWkid ?? undefined,
      wkt: extent.spatialReference.wkt ?? undefined,
    },
  }
}
