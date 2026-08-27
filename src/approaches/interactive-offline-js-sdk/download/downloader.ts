import Extent from '@arcgis/core/geometry/Extent.js'
import type FeatureLayer from '@arcgis/core/layers/FeatureLayer.js'
import {
  createDirectoryStorageReference,
  readPackageFile,
  writePackageFile,
} from '../../../shared/storage/directory.ts'
import { getPortalThumbnailUrl } from '../arcgis/portal.ts'
import {
  deletePackage,
  finalizePackage,
  getFeatureChunks,
  getLayerSnapshots,
  putFeatureChunk,
  putLayerSnapshot,
  putPackage,
} from '../storage/database.ts'
import type {
  DownloadOptions,
  FeatureLayerSnapshot,
  FeatureLayerSource,
  JsonObject,
  JsonValue,
  LiveMapSession,
  PreflightReport,
  SavedMapPackage,
  StoredMapResource,
} from '../types.ts'
import { serializeArcGisJson } from '../types.ts'
import { snapshotWebMapJson } from './preflight.ts'

const featureBatchSize = 500
const resourceConcurrency = 6

function asJsonObject(value: JsonValue | undefined): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined
}

function findRawLayer(webMapJson: JsonObject, layerId: string): JsonObject | undefined {
  const collections: JsonValue[][] = []
  if (Array.isArray(webMapJson.operationalLayers)) {
    collections.push(webMapJson.operationalLayers)
  }
  const basemap = asJsonObject(webMapJson.baseMap) ?? asJsonObject(webMapJson.basemap)
  if (Array.isArray(basemap?.baseMapLayers)) {
    collections.push(basemap.baseMapLayers)
  }
  if (Array.isArray(basemap?.referenceLayers)) {
    collections.push(basemap.referenceLayers)
  }
  for (let index = 0; index < collections.length; index += 1) {
    for (const value of collections[index]) {
      const layer = asJsonObject(value)
      if (layer?.id === layerId) {
        return layer
      }
      if (layer?.layerType === 'GroupLayer' && Array.isArray(layer.layers)) {
        collections.push(layer.layers)
      }
    }
  }
  return undefined
}

function getFeatureLayerSource(
  webMapJson: JsonObject,
  layerId: string,
): FeatureLayerSource {
  if (findRawLayer(webMapJson, layerId)) {
    return { kind: 'layer', layerId }
  }
  const childMatch = /^(.*)-sublayer-(\d+)$/.exec(layerId)
  if (childMatch) {
    const layerIndex = Number(childMatch[2])
    const parent = findRawLayer(webMapJson, childMatch[1])
    const featureCollection = parent
      ? asJsonObject(parent.featureCollection)
      : undefined
    if (Array.isArray(featureCollection?.layers) && featureCollection.layers[layerIndex]) {
      return {
        kind: 'feature-collection-layer',
        layerIndex,
        parentLayerId: childMatch[1],
      }
    }
  }
  return { kind: 'layer', layerId }
}

function createPackageRecord(
  session: LiveMapSession,
  report: PreflightReport,
  options: DownloadOptions,
): SavedMapPackage {
  const version = `${Date.now()}-${crypto.randomUUID()}`
  const payloadStorage = options.destination
    ? createDirectoryStorageReference(
        options.destination,
        'interactive-map',
        `map-${session.item.id}-${version}`,
      )
    : { kind: 'browser' as const }
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
    payloadStorage,
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
    source: getFeatureLayerSource(packageRecord.webMapJson, featureLayer.id),
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
    await putFeatureChunk(
      {
        chunkId: `${packageRecord.packageId}:${featureLayer.id}:${index}`,
        features,
        index,
        layerId: featureLayer.id,
        packageId: packageRecord.packageId,
      },
      packageRecord.payloadStorage?.kind === 'directory'
        ? packageRecord.payloadStorage
        : undefined,
    )
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
): Promise<{ bytes: number; resources: StoredMapResource[] }> {
  const cache = packageRecord.payloadStorage?.kind === 'directory'
    ? undefined
    : await caches.open(packageRecord.cacheName)
  let currentIndex = 0
  let completed = 0
  let bytes = 0
  const resources: StoredMapResource[] = []

  const worker = async () => {
    while (currentIndex < report.resourceUrls.length) {
      const resourceIndex = currentIndex
      const resource = report.resourceUrls[resourceIndex]
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

      const contentType = response.headers.get('content-type') ?? 'application/octet-stream'
      if (packageRecord.payloadStorage?.kind === 'directory') {
        const blob = await response.blob()
        const path = `resources/${resourceIndex}.bin`
        await writePackageFile(packageRecord.payloadStorage, path, blob)
        bytes += blob.size
        resources.push({
          contentType,
          path,
          size: blob.size,
          url: resource.url,
        })
      } else {
        const contentLength = Number(response.headers.get('content-length'))
        const size = Number.isFinite(contentLength) && contentLength > 0
          ? contentLength
          : (await response.clone().arrayBuffer()).byteLength
        bytes += size
        await cache?.put(request, response)
        resources.push({
          contentType,
          size,
          url: resource.url,
        })
      }
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

  return { bytes, resources }
}

async function verifyPackage(
  packageRecord: SavedMapPackage,
  report: PreflightReport,
): Promise<void> {
  const [layerSnapshots, featureChunks] = await Promise.all([
    getLayerSnapshots(packageRecord.packageId),
    Promise.all(report.featurePlans.map((plan) => (
      getFeatureChunks(packageRecord.packageId, plan.layerId)
    ))),
  ])

  if (layerSnapshots.length !== report.featurePlans.length) {
    throw new Error(
      `Offline verification found ${layerSnapshots.length} of ${report.featurePlans.length} feature layers.`,
    )
  }
  const storedFeatureCount = featureChunks
    .flat()
    .reduce((total, chunk) => total + chunk.features.length, 0)
  const expectedFeatureCount = report.featurePlans
    .reduce((total, plan) => total + plan.featureCount, 0)
  if (storedFeatureCount !== expectedFeatureCount) {
    throw new Error(
      `Offline verification found ${storedFeatureCount} of ${expectedFeatureCount} feature records.`,
    )
  }
  if (packageRecord.resources?.length !== report.resourceUrls.length) {
    throw new Error(
      `Offline verification found ${packageRecord.resources?.length ?? 0} of ${report.resourceUrls.length} stored resources.`,
    )
  }
  if (packageRecord.payloadStorage?.kind === 'directory') {
    for (const resource of packageRecord.resources) {
      if (!resource.path) {
        throw new Error(`Offline verification found no file for ${resource.url}.`)
      }
      const file = await readPackageFile(packageRecord.payloadStorage, resource.path)
      if (file.size !== resource.size) {
        throw new Error(`Offline verification found an incomplete file for ${resource.url}.`)
      }
    }
  } else {
    const cache = await caches.open(packageRecord.cacheName)
    const cachedRequests = await cache.keys()
    if (cachedRequests.length !== report.resourceUrls.length) {
      throw new Error(
        `Offline verification found ${cachedRequests.length} of ${report.resourceUrls.length} cached resources.`,
      )
    }
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

  const packageRecord = createPackageRecord(session, report, options)
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
    const thumbnailResource = thumbnailUrl
      ? resources.resources.find((resource) => resource.url === thumbnailUrl)
      : undefined
    const thumbnailBlob = thumbnailResource?.path && packageRecord.payloadStorage?.kind === 'directory'
      ? await readPackageFile(packageRecord.payloadStorage, thumbnailResource.path)
      : thumbnailUrl
        ? await (await caches.open(packageRecord.cacheName)).match(thumbnailUrl)
          .then((response) => response?.blob())
        : undefined

    const populatedPackage: SavedMapPackage = {
      ...packageRecord,
      byteSize,
      featureCount,
      resourceCount: resources.resources.length,
      resources: resources.resources,
      thumbnailBlob,
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
