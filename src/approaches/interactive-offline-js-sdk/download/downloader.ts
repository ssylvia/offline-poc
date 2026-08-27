import Extent from '@arcgis/core/geometry/Extent.js'
import type FeatureLayer from '@arcgis/core/layers/FeatureLayer.js'
import { getPortalThumbnailUrl } from '../arcgis/portal.ts'
import {
  deletePackage,
  finalizePackage,
  getLayerSnapshots,
  putFeatureChunk,
  putLayerSnapshot,
  putPackage,
} from '../storage/database.ts'
import type {
  DownloadOptions,
  FeatureLayerSnapshot,
  JsonObject,
  LiveMapSession,
  PreflightReport,
  SavedMapPackage,
} from '../types.ts'
import { serializeArcGisJson } from '../types.ts'
import { snapshotWebMapJson } from './preflight.ts'

const featureBatchSize = 500
const resourceConcurrency = 6

function createPackageRecord(
  session: LiveMapSession,
  report: PreflightReport,
): SavedMapPackage {
  const version = `${Date.now()}-${crypto.randomUUID()}`
  return {
    byteSize: 0,
    cacheName: `offline-webmap-${session.item.id}-${version}`,
    compatibility: report.layerResults,
    coverageExtent: report.coverageExtent,
    createdAt: Date.now(),
    featureCount: 0,
    item: session.item,
    itemData: session.itemData,
    levels: report.levels,
    packageId: `${session.item.id}:${version}`,
    resourceCount: 0,
    sdkVersion: __ARCGIS_SDK_VERSION__,
    state: 'staging',
    viewpoint: serializeArcGisJson(session.view.viewpoint),
    webMapJson: snapshotWebMapJson(session),
  }
}

function chunkValues<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

async function downloadFeatureLayer(
  packageRecord: SavedMapPackage,
  featureLayer: FeatureLayer,
  report: PreflightReport,
  options: DownloadOptions,
): Promise<{ bytes: number; featureCount: number }> {
  const query = featureLayer.createQuery()
  query.geometry = Extent.fromJSON(report.coverageExtent)
  query.spatialRelationship = 'intersects'
  query.returnGeometry = true
  query.outFields = ['*']

  const objectIds = await featureLayer.queryObjectIds(query, { signal: options.signal })
  options.signal.throwIfAborted()
  const sortedObjectIds = [...objectIds].sort((left, right) => (
    String(left).localeCompare(String(right), undefined, { numeric: true })
  ))
  const objectIdChunks = chunkValues(sortedObjectIds, featureBatchSize)
  const layerJson = serializeArcGisJson(featureLayer)
  const snapshot: FeatureLayerSnapshot = {
    fields: featureLayer.fields.map((field) => serializeArcGisJson(field)),
    geometryType: featureLayer.geometryType,
    layerId: featureLayer.id,
    layerJson,
    objectIdField: featureLayer.objectIdField,
    packageId: packageRecord.packageId,
    spatialReference: serializeArcGisJson(featureLayer.spatialReference),
  }
  await putLayerSnapshot(snapshot)

  let bytes = JSON.stringify(layerJson).length * 2
  let featureCount = 0

  if (objectIdChunks.length === 0) {
    options.onProgress({
      completed: 1,
      detail: `${featureLayer.title}: no intersecting features`,
      phase: 'features',
      total: 1,
    })
    return { bytes, featureCount }
  }

  for (const [index, ids] of objectIdChunks.entries()) {
    options.signal.throwIfAborted()
    const batchQuery = featureLayer.createQuery()
    batchQuery.objectIds = ids
    batchQuery.outFields = ['*']
    batchQuery.returnGeometry = true
    batchQuery.outSpatialReference = featureLayer.spatialReference
    const featureSet = await featureLayer.queryFeatures(batchQuery, { signal: options.signal })
    const features = featureSet.features.map((feature) => feature.toJSON() as JsonObject)
    await putFeatureChunk({
      chunkId: `${packageRecord.packageId}:${featureLayer.id}:${index}`,
      features,
      index,
      layerId: featureLayer.id,
      packageId: packageRecord.packageId,
    })
    bytes += JSON.stringify(features).length * 2
    featureCount += features.length
    options.onProgress({
      completed: index + 1,
      detail: `${featureLayer.title}: ${featureCount.toLocaleString()} of ${sortedObjectIds.length.toLocaleString()} features`,
      phase: 'features',
      total: objectIdChunks.length,
    })
  }

  return { bytes, featureCount }
}

async function downloadResources(
  packageRecord: SavedMapPackage,
  report: PreflightReport,
  options: DownloadOptions,
): Promise<{ bytes: number; resourceCount: number }> {
  const cache = await caches.open(packageRecord.cacheName)
  let currentIndex = 0
  let completed = 0
  let bytes = 0

  const worker = async () => {
    while (currentIndex < report.resourceUrls.length) {
      const resource = report.resourceUrls[currentIndex]
      currentIndex += 1
      options.signal.throwIfAborted()

      const request = new Request(resource.url, {
        credentials: 'omit',
        mode: 'cors',
      })
      const response = await fetch(request, { signal: options.signal })
      if (!response.ok) {
        throw new Error(
          `Failed to cache ${resource.url}: HTTP ${response.status} ${response.statusText}`,
        )
      }

      const contentLength = Number(response.headers.get('content-length'))
      if (Number.isFinite(contentLength) && contentLength > 0) {
        bytes += contentLength
      } else {
        bytes += (await response.clone().arrayBuffer()).byteLength
      }
      await cache.put(request, response)
      completed += 1
      options.onProgress({
        completed,
        detail: `Caching ${resource.layerId} resources`,
        phase: 'resources',
        total: report.resourceUrls.length,
      })
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(resourceConcurrency, report.resourceUrls.length) },
      () => worker(),
    ),
  )

  return { bytes, resourceCount: completed }
}

async function verifyPackage(
  packageRecord: SavedMapPackage,
  report: PreflightReport,
): Promise<void> {
  const [layerSnapshots, cache] = await Promise.all([
    getLayerSnapshots(packageRecord.packageId),
    caches.open(packageRecord.cacheName),
  ])
  const cachedRequests = await cache.keys()

  if (layerSnapshots.length !== report.featurePlans.length) {
    throw new Error(
      `Offline verification found ${layerSnapshots.length} of ${report.featurePlans.length} feature layers.`,
    )
  }
  if (cachedRequests.length !== report.resourceUrls.length) {
    throw new Error(
      `Offline verification found ${cachedRequests.length} of ${report.resourceUrls.length} cached resources.`,
    )
  }
}

export async function downloadOfflineMap(
  session: LiveMapSession,
  report: PreflightReport,
  options: DownloadOptions,
): Promise<SavedMapPackage> {
  if (report.hasLimitations && !options.allowDegraded) {
    throw new Error('Review and approve the listed compatibility limitations first.')
  }

  const packageRecord = createPackageRecord(session, report)
  await putPackage(packageRecord)

  try {
    options.onProgress({
      completed: 0,
      detail: 'Creating an atomic staging package',
      phase: 'preparing',
      total: 1,
    })

    let byteSize = JSON.stringify(packageRecord).length * 2
    let featureCount = 0
    for (const [index, featurePlan] of report.featurePlans.entries()) {
      options.signal.throwIfAborted()
      const result = await downloadFeatureLayer(
        packageRecord,
        featurePlan.layer as FeatureLayer,
        report,
        options,
      )
      byteSize += result.bytes
      featureCount += result.featureCount
      options.onProgress({
        completed: index + 1,
        detail: `Saved ${featurePlan.title}`,
        phase: 'features',
        total: report.featurePlans.length,
      })
    }

    const resources = await downloadResources(packageRecord, report, options)
    byteSize += resources.bytes

    const thumbnailUrl = getPortalThumbnailUrl(session.item)
    const thumbnailResponse = thumbnailUrl
      ? await (await caches.open(packageRecord.cacheName)).match(thumbnailUrl)
      : undefined

    const populatedPackage: SavedMapPackage = {
      ...packageRecord,
      byteSize,
      featureCount,
      resourceCount: resources.resourceCount,
      thumbnailBlob: thumbnailResponse ? await thumbnailResponse.blob() : undefined,
    }
    await putPackage(populatedPackage)

    options.onProgress({
      completed: 0,
      detail: 'Checking stored features and cached resources',
      phase: 'verifying',
      total: 1,
    })
    await verifyPackage(populatedPackage, report)

    const completedPackage = await finalizePackage(populatedPackage)
    options.onProgress({
      completed: 1,
      detail: 'Offline package is ready',
      phase: 'complete',
      total: 1,
    })
    return completedPackage
  } catch (error) {
    await deletePackage(packageRecord)
    throw error
  }
}
