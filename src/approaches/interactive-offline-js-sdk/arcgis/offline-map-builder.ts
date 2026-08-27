import WebMap from '@arcgis/core/WebMap.js'
import Graphic from '@arcgis/core/Graphic.js'
import SpatialReference from '@arcgis/core/geometry/SpatialReference.js'
import type Layer from '@arcgis/core/layers/Layer.js'
import FeatureLayer from '@arcgis/core/layers/FeatureLayer.js'
import Field, { type FieldProperties } from '@arcgis/core/layers/support/Field.js'
import type Collection from '@arcgis/core/core/Collection.js'
import {
  getFeatureChunks,
  getLayerSnapshots,
} from '../storage/database.ts'
import type {
  FeatureLayerSnapshot,
  SavedMapPackage,
} from '../types.ts'

type LayerCollection = Collection<Layer>

const fieldTypeMap: Record<string, FieldProperties['type']> = {
  esriFieldTypeBigInteger: 'big-integer',
  esriFieldTypeBlob: 'blob',
  esriFieldTypeDate: 'date',
  esriFieldTypeDateOnly: 'date-only',
  esriFieldTypeDouble: 'double',
  esriFieldTypeGeometry: 'geometry',
  esriFieldTypeGlobalID: 'global-id',
  esriFieldTypeGUID: 'guid',
  esriFieldTypeInteger: 'integer',
  esriFieldTypeLong: 'long',
  esriFieldTypeOID: 'oid',
  esriFieldTypeRaster: 'raster',
  esriFieldTypeSingle: 'single',
  esriFieldTypeSmallInteger: 'small-integer',
  esriFieldTypeString: 'string',
  esriFieldTypeTimeOnly: 'time-only',
  esriFieldTypeTimestampOffset: 'timestamp-offset',
  esriFieldTypeXML: 'xml',
}

function createField(fieldJson: FeatureLayerSnapshot['fields'][number]): Field {
  const jsonType = fieldJson.type
  const type = typeof jsonType === 'string'
    ? fieldTypeMap[jsonType] ?? jsonType as FieldProperties['type']
    : undefined

  return new Field({
    ...fieldJson,
    type,
  } as FieldProperties)
}

function getLayerCollections(map: WebMap): LayerCollection[] {
  const collections: LayerCollection[] = [map.layers]
  if (map.basemap) {
    collections.push(map.basemap.baseLayers, map.basemap.referenceLayers)
  }

  for (let index = 0; index < collections.length; index += 1) {
    for (const layer of collections[index].toArray()) {
      if (layer.type === 'group' && 'layers' in layer) {
        collections.push(layer.layers as LayerCollection)
      }
    }
  }

  return collections
}

function findLayerLocation(
  map: WebMap,
  layerId: string,
): { collection: LayerCollection; index: number; layer: Layer } | undefined {
  for (const collection of getLayerCollections(map)) {
    const index = collection.toArray().findIndex((layer) => layer.id === layerId)
    if (index >= 0) {
      const layer = collection.at(index)
      if (layer) {
        return { collection, index, layer }
      }
    }
  }
  return undefined
}

async function createClientFeatureLayer(
  packageRecord: SavedMapPackage,
  snapshot: FeatureLayerSnapshot,
  original: FeatureLayer,
): Promise<FeatureLayer> {
  const chunks = await getFeatureChunks(packageRecord.packageId, snapshot.layerId)
  const source = chunks.flatMap((chunk) => chunk.features.map((feature) => Graphic.fromJSON(feature)))

  return new FeatureLayer({
    copyright: original.copyright,
    definitionExpression: original.definitionExpression,
    displayField: original.displayField,
    editingEnabled: false,
    elevationInfo: original.elevationInfo,
    featureReduction: original.featureReduction,
    fields: snapshot.fields.map(createField),
    geometryType: original.geometryType,
    id: original.id,
    labelingInfo: original.labelingInfo,
    labelsVisible: original.labelsVisible,
    legendEnabled: original.legendEnabled,
    listMode: original.listMode,
    maxScale: original.maxScale,
    minScale: original.minScale,
    objectIdField: snapshot.objectIdField,
    opacity: original.opacity,
    outFields: ['*'],
    popupEnabled: original.popupEnabled,
    popupTemplate: original.popupTemplate,
    renderer: original.renderer,
    source,
    spatialReference: SpatialReference.fromJSON(snapshot.spatialReference),
    title: original.title,
    visible: original.visible,
  })
}

export async function buildOfflineWebMap(packageRecord: SavedMapPackage): Promise<WebMap> {
  const map = WebMap.fromJSON(packageRecord.webMapJson)
  await map.load()
  const featureSnapshots = await getLayerSnapshots(packageRecord.packageId)

  for (const snapshot of featureSnapshots) {
    const location = findLayerLocation(map, snapshot.layerId)
    if (!location) {
      throw new Error(`Saved feature layer ${snapshot.layerId} is missing from the WebMap snapshot.`)
    }

    if (location.layer.type !== 'feature') {
      throw new Error(`Saved layer ${snapshot.layerId} is no longer a feature layer.`)
    }
    const clientLayer = await createClientFeatureLayer(
      packageRecord,
      snapshot,
      location.layer as FeatureLayer,
    )
    location.collection.removeAt(location.index)
    location.collection.add(clientLayer, location.index)
  }

  for (const unsupported of packageRecord.compatibility.filter(
    (result) => result.level === 'unsupported',
  )) {
    const location = findLayerLocation(map, unsupported.id)
    if (location) {
      location.collection.removeAt(location.index)
    }
  }

  return map
}
