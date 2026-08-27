import WebMap from '@arcgis/core/WebMap.js'
import {
  getFeatureChunks,
  getLayerSnapshots,
} from '../storage/database.ts'
import type {
  FeatureLayerSnapshot,
  FeatureLayerSource,
  JsonObject,
  JsonValue,
  SavedMapPackage,
} from '../types.ts'

type LayerJsonCollection = JsonValue[]

const geometryTypeMap: Record<string, string> = {
  multipatch: 'esriGeometryMultiPatch',
  multipoint: 'esriGeometryMultipoint',
  point: 'esriGeometryPoint',
  polygon: 'esriGeometryPolygon',
  polyline: 'esriGeometryPolyline',
}

function asJsonObject(value: JsonValue | undefined): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined
}

function getLayerCollections(webMapJson: JsonObject): LayerJsonCollection[] {
  const collections: LayerJsonCollection[] = []
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
      if (layer?.layerType === 'GroupLayer' && Array.isArray(layer.layers)) {
        collections.push(layer.layers)
      }
    }
  }

  return collections
}

function findLayerLocation(
  webMapJson: JsonObject,
  layerId: string,
): { collection: LayerJsonCollection; index: number; layer: JsonObject } | undefined {
  for (const collection of getLayerCollections(webMapJson)) {
    const index = collection.findIndex((value) => asJsonObject(value)?.id === layerId)
    if (index >= 0) {
      const layer = asJsonObject(collection[index])
      if (layer) {
        return { collection, index, layer }
      }
    }
  }
  return undefined
}

function isFeatureLayerJson(layer: JsonObject): boolean {
  return layer.layerType === 'ArcGISFeatureLayer' || layer.type === 'Feature Collection'
}

function inferFeatureLayerSource(
  webMapJson: JsonObject,
  snapshot: FeatureLayerSnapshot,
): FeatureLayerSource {
  if (snapshot.source) {
    return snapshot.source
  }
  if (findLayerLocation(webMapJson, snapshot.layerId)) {
    return { kind: 'layer', layerId: snapshot.layerId }
  }
  const childMatch = /^(.*)-sublayer-(\d+)$/.exec(snapshot.layerId)
  if (childMatch) {
    const layerIndex = Number(childMatch[2])
    const parent = findLayerLocation(webMapJson, childMatch[1])
    const featureCollection = parent
      ? asJsonObject(parent.layer.featureCollection)
      : undefined
    if (Array.isArray(featureCollection?.layers) && featureCollection.layers[layerIndex]) {
      return {
        kind: 'feature-collection-layer',
        layerIndex,
        parentLayerId: childMatch[1],
      }
    }
  }
  return { kind: 'layer', layerId: snapshot.layerId }
}

function getGeometryType(snapshot: FeatureLayerSnapshot): string | undefined {
  if (!snapshot.geometryType) {
    return undefined
  }
  return geometryTypeMap[snapshot.geometryType] ?? snapshot.geometryType
}

async function createClientFeatureLayerJson(
  packageRecord: SavedMapPackage,
  snapshot: FeatureLayerSnapshot,
  original: JsonObject,
): Promise<JsonObject> {
  const chunks = await getFeatureChunks(packageRecord.packageId, snapshot.layerId)
  const geometryType = getGeometryType(snapshot)
  const snapshotDefinition = asJsonObject(snapshot.layerJson.layerDefinition)
  const originalDefinition = asJsonObject(original.layerDefinition)
  const layerDefinition: JsonObject = {
    ...structuredClone(snapshotDefinition ?? {}),
    ...structuredClone(originalDefinition ?? {}),
    fields: structuredClone(snapshot.fields),
    objectIdField: snapshot.objectIdField,
    spatialReference: structuredClone(snapshot.spatialReference),
    ...(geometryType ? { geometryType } : {}),
  }

  delete layerDefinition.source

  const featureSet: JsonObject = {
    features: structuredClone(chunks.flatMap((chunk) => chunk.features)),
    spatialReference: structuredClone(snapshot.spatialReference),
    ...(geometryType ? { geometryType } : {}),
  }
  const clientLayer: JsonObject = {
    ...structuredClone(snapshot.layerJson),
    ...original,
    id: snapshot.layerId,
    layerDefinition,
    layerType: 'ArcGISFeatureLayer',
    featureCollection: {
      layers: [{
        featureSet,
        layerDefinition: structuredClone(layerDefinition),
      }],
    },
  }

  delete clientLayer.itemId
  delete clientLayer.portalItem
  delete clientLayer.serviceItemId
  delete clientLayer.url
  return clientLayer
}

async function createFeatureCollectionLayerJson(
  packageRecord: SavedMapPackage,
  snapshot: FeatureLayerSnapshot,
  original: JsonObject,
): Promise<JsonObject> {
  const chunks = await getFeatureChunks(packageRecord.packageId, snapshot.layerId)
  const geometryType = getGeometryType(snapshot)
  const snapshotDefinition = asJsonObject(snapshot.layerJson.layerDefinition)
  const originalDefinition = asJsonObject(original.layerDefinition)
  const originalFeatureSet = asJsonObject(original.featureSet)
  const layerDefinition: JsonObject = {
    ...structuredClone(snapshotDefinition ?? {}),
    ...structuredClone(originalDefinition ?? {}),
    fields: structuredClone(snapshot.fields),
    objectIdField: snapshot.objectIdField,
    spatialReference: structuredClone(snapshot.spatialReference),
    ...(geometryType ? { geometryType } : {}),
  }
  delete layerDefinition.source

  return {
    ...structuredClone(original),
    layerDefinition,
    featureSet: {
      ...structuredClone(originalFeatureSet ?? {}),
      features: structuredClone(chunks.flatMap((chunk) => chunk.features)),
      spatialReference: structuredClone(snapshot.spatialReference),
      ...(geometryType ? { geometryType } : {}),
    },
  }
}

export async function buildOfflineWebMap(packageRecord: SavedMapPackage): Promise<WebMap> {
  const webMapJson = structuredClone(packageRecord.webMapJson)
  const featureSnapshots = await getLayerSnapshots(packageRecord.packageId)

  for (const snapshot of featureSnapshots) {
    const source = inferFeatureLayerSource(webMapJson, snapshot)
    if (source.kind === 'feature-collection-layer') {
      const parentLocation = findLayerLocation(webMapJson, source.parentLayerId)
      const featureCollection = parentLocation
        ? asJsonObject(parentLocation.layer.featureCollection)
        : undefined
      const collectionLayers = featureCollection?.layers
      const original = Array.isArray(collectionLayers)
        ? asJsonObject(collectionLayers[source.layerIndex])
        : undefined
      if (!parentLocation || !featureCollection || !Array.isArray(collectionLayers) || !original) {
        throw new Error(
          `Saved feature collection layer ${snapshot.layerId} is missing from the WebMap snapshot.`,
        )
      }
      collectionLayers.splice(
        source.layerIndex,
        1,
        await createFeatureCollectionLayerJson(packageRecord, snapshot, original),
      )
      continue
    }

    const location = findLayerLocation(webMapJson, source.layerId)
    if (!location) {
      throw new Error(`Saved feature layer ${snapshot.layerId} is missing from the WebMap snapshot.`)
    }

    if (!isFeatureLayerJson(location.layer)) {
      throw new Error(`Saved layer ${snapshot.layerId} is no longer a feature layer.`)
    }
    const clientLayer = await createClientFeatureLayerJson(
      packageRecord,
      snapshot,
      location.layer,
    )
    location.collection.splice(location.index, 1, clientLayer)
  }

  for (const unsupported of packageRecord.compatibility.filter(
    (result) => result.level === 'unsupported',
  )) {
    const location = findLayerLocation(webMapJson, unsupported.id)
    if (location) {
      location.collection.splice(location.index, 1)
    }
  }

  return WebMap.fromJSON(webMapJson)
}
