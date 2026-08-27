import { beforeEach, describe, expect, it, vi } from 'vitest'
import type FeatureLayer from '@arcgis/core/layers/FeatureLayer.js'
import type {
  FeatureLayerSnapshot,
  JsonObject,
  JsonValue,
  SavedMapPackage,
} from '../types.ts'

const mocks = vi.hoisted(() => ({
  fromJSON: vi.fn(),
  getFeatureChunks: vi.fn(),
  getLayerSnapshots: vi.fn(),
  load: vi.fn(),
}))

vi.mock('@arcgis/core/WebMap.js', () => ({
  default: {
    fromJSON: mocks.fromJSON,
  },
}))

vi.mock('../storage/database.ts', () => ({
  getFeatureChunks: mocks.getFeatureChunks,
  getLayerSnapshots: mocks.getLayerSnapshots,
}))

import { buildOfflineWebMap } from './offline-map-builder.ts'

function createPackage(webMapJson: JsonObject): SavedMapPackage {
  return {
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
    webMapJson,
  }
}

function createSnapshot(layerId: string): FeatureLayerSnapshot {
  return {
    fields: [{
      alias: 'Object ID',
      name: 'OBJECTID',
      type: 'esriFieldTypeOID',
    }],
    geometryType: 'point',
    layerId,
    layerJson: {
      id: layerId,
      layerDefinition: {
        drawingInfo: {
          renderer: {
            symbol: { type: 'esriSMS' },
            type: 'simple',
          },
        },
      },
      layerType: 'ArcGISFeatureLayer',
      url: `https://example.com/FeatureServer/${layerId}`,
    },
    objectIdField: 'OBJECTID',
    packageId: 'test-package',
    spatialReference: { wkid: 4326 },
  }
}

function asObject(value: JsonValue | undefined): JsonObject {
  expect(value).toBeTruthy()
  expect(Array.isArray(value)).toBe(false)
  expect(typeof value).toBe('object')
  return value as JsonObject
}

function asArray(value: JsonValue | undefined): JsonValue[] {
  expect(Array.isArray(value)).toBe(true)
  return value as JsonValue[]
}

function layerIds(layers: JsonValue[]): Array<JsonValue | undefined> {
  return layers.map((layer) => asObject(layer).id)
}

describe('buildOfflineWebMap', () => {
  beforeEach(() => {
    mocks.fromJSON.mockReset().mockReturnValue({ load: mocks.load })
    mocks.getFeatureChunks.mockReset()
    mocks.getLayerSnapshots.mockReset()
    mocks.load.mockReset()
  })

  it('localizes saved features and removes unsupported layers before creating the WebMap', async () => {
    const webMapJson: JsonObject = {
      baseMap: {
        baseMapLayers: [
          { id: 'base-before', layerType: 'ArcGISTiledMapServiceLayer' },
          {
            id: 'base-saved',
            itemId: 'remote-item',
            layerType: 'ArcGISFeatureLayer',
            url: 'https://example.com/FeatureServer/2',
          },
          { id: 'base-unsupported', layerType: 'WMS' },
        ],
        referenceLayers: [
          { id: 'reference-unsupported', layerType: 'WMS' },
          {
            id: 'reference-after',
            layerType: 'ArcGISTiledMapServiceLayer',
          },
        ],
        title: 'Saved basemap',
      },
      operationalLayers: [
        { id: 'operational-before', layerType: 'ArcGISTiledMapServiceLayer' },
        {
          id: 'group',
          layerType: 'GroupLayer',
          layers: [
            { id: 'group-before', layerType: 'ArcGISTiledMapServiceLayer' },
            {
              id: 'saved-feature',
              layerDefinition: { definitionExpression: 'STATUS = 1' },
              layerType: 'ArcGISFeatureLayer',
              title: 'Saved feature',
              url: 'https://example.com/FeatureServer/1',
              visibility: false,
            },
            { id: 'nested-unsupported', layerType: 'WFS' },
            { id: 'group-after', layerType: 'ArcGISTiledMapServiceLayer' },
          ],
        },
        { id: 'operational-after', layerType: 'ArcGISTiledMapServiceLayer' },
      ],
      version: '2.30',
    }
    const packageRecord = createPackage(webMapJson)
    packageRecord.compatibility = [
      {
        id: 'nested-unsupported',
        level: 'unsupported',
        message: 'Not available offline',
        title: 'Nested unsupported',
        type: 'wfs',
      },
      {
        id: 'base-unsupported',
        level: 'unsupported',
        message: 'Not available offline',
        title: 'Basemap unsupported',
        type: 'wms',
      },
      {
        id: 'reference-unsupported',
        level: 'unsupported',
        message: 'Not available offline',
        title: 'Reference unsupported',
        type: 'wms',
      },
    ]
    mocks.getLayerSnapshots.mockResolvedValue([
      createSnapshot('saved-feature'),
      createSnapshot('base-saved'),
    ])
    mocks.getFeatureChunks.mockImplementation(async (_packageId: string, layerId: string) => [{
      chunkId: `${layerId}:0`,
      features: [{
        attributes: { OBJECTID: layerId === 'saved-feature' ? 1 : 2 },
        geometry: { x: 1, y: 2 },
      }],
      index: 0,
      layerId,
      packageId: 'test-package',
    }])

    const map = await buildOfflineWebMap(packageRecord)

    expect(map).toBe(mocks.fromJSON.mock.results[0].value)
    expect(mocks.load).not.toHaveBeenCalled()
    expect(mocks.fromJSON).toHaveBeenCalledOnce()

    const localizedJson = mocks.fromJSON.mock.calls[0][0] as JsonObject
    const operationalLayers = asArray(localizedJson.operationalLayers)
    expect(layerIds(operationalLayers)).toEqual([
      'operational-before',
      'group',
      'operational-after',
    ])

    const groupLayers = asArray(asObject(operationalLayers[1]).layers)
    expect(layerIds(groupLayers)).toEqual([
      'group-before',
      'saved-feature',
      'group-after',
    ])
    const savedFeature = asObject(groupLayers[1])
    expect(savedFeature).toMatchObject({
      id: 'saved-feature',
      layerDefinition: {
        definitionExpression: 'STATUS = 1',
        geometryType: 'esriGeometryPoint',
        objectIdField: 'OBJECTID',
      },
      layerType: 'ArcGISFeatureLayer',
      title: 'Saved feature',
      visibility: false,
    })
    expect(savedFeature).not.toHaveProperty('url')
    expect(
      asObject(asArray(asObject(savedFeature.featureCollection).layers)[0]),
    ).toMatchObject({
      featureSet: {
        features: [{
          attributes: { OBJECTID: 1 },
          geometry: { x: 1, y: 2 },
        }],
        geometryType: 'esriGeometryPoint',
        spatialReference: { wkid: 4326 },
      },
      layerDefinition: {
        fields: [{
          alias: 'Object ID',
          name: 'OBJECTID',
          type: 'esriFieldTypeOID',
        }],
      },
    })

    const basemapLayers = asArray(asObject(localizedJson.baseMap).baseMapLayers)
    expect(layerIds(basemapLayers)).toEqual([
      'base-before',
      'base-saved',
    ])
    expect(asObject(basemapLayers[1])).not.toHaveProperty('itemId')
    expect(asObject(basemapLayers[1])).not.toHaveProperty('url')
    const referenceLayers = asArray(asObject(localizedJson.baseMap).referenceLayers)
    expect(layerIds(referenceLayers)).toEqual(['reference-after'])

    const originalGroup = asObject(asArray(webMapJson.operationalLayers)[1])
    expect(layerIds(asArray(originalGroup.layers))).toEqual([
      'group-before',
      'saved-feature',
      'nested-unsupported',
      'group-after',
    ])
    expect(asObject(asArray(originalGroup.layers)[1]).url).toBe(
      'https://example.com/FeatureServer/1',
    )
  })

  it('preserves the missing saved layer error without constructing a WebMap', async () => {
    mocks.getLayerSnapshots.mockResolvedValue([createSnapshot('missing-feature')])
    const packageRecord = createPackage({
      operationalLayers: [],
      version: '2.30',
    })

    await expect(buildOfflineWebMap(packageRecord)).rejects.toThrow(
      'Saved feature layer missing-feature is missing from the WebMap snapshot.',
    )
    expect(mocks.fromJSON).not.toHaveBeenCalled()
    expect(mocks.getFeatureChunks).not.toHaveBeenCalled()
  })

  it('localizes generated child IDs inside multi-layer feature collections', async () => {
    const first = createSnapshot('collection-sublayer-0')
    first.source = {
      kind: 'feature-collection-layer',
      layerIndex: 0,
      parentLayerId: 'collection',
    }
    mocks.getLayerSnapshots.mockResolvedValue([first])
    mocks.getFeatureChunks.mockResolvedValue([{
      chunkId: 'collection-sublayer-0:0',
      features: [{ attributes: { OBJECTID: 42 }, geometry: { x: 1, y: 2 } }],
      index: 0,
      layerId: first.layerId,
      packageId: 'test-package',
    }])
    const packageRecord = createPackage({
      operationalLayers: [{
        featureCollection: {
          layers: [{
            featureSet: { features: [] },
            layerDefinition: { name: 'First child' },
          }, {
            featureSet: { features: [{ attributes: { OBJECTID: 99 } }] },
            layerDefinition: { name: 'Second child' },
          }],
        },
        id: 'collection',
        type: 'Feature Collection',
      }],
      version: '2.30',
    })

    await buildOfflineWebMap(packageRecord)

    const localizedJson = mocks.fromJSON.mock.calls[0][0] as JsonObject
    const parent = asObject(asArray(localizedJson.operationalLayers)[0])
    const layers = asArray(asObject(parent.featureCollection).layers)
    expect(asObject(asObject(layers[0]).featureSet).features).toEqual([
      { attributes: { OBJECTID: 42 }, geometry: { x: 1, y: 2 } },
    ])
    expect(asObject(asObject(layers[1]).featureSet).features).toEqual([
      { attributes: { OBJECTID: 99 } },
    ])
  })

  it('keeps an ordinary layer whose ID ends with a generated-child suffix', async () => {
    const snapshot = createSnapshot('roads-sublayer-0')
    mocks.getLayerSnapshots.mockResolvedValue([snapshot])
    mocks.getFeatureChunks.mockResolvedValue([])
    const packageRecord = createPackage({
      operationalLayers: [{
        id: 'roads-sublayer-0',
        layerType: 'ArcGISFeatureLayer',
        url: 'https://example.com/FeatureServer/0',
      }],
      version: '2.30',
    })

    await buildOfflineWebMap(packageRecord)

    const localizedJson = mocks.fromJSON.mock.calls[0][0] as JsonObject
    const layer = asObject(asArray(localizedJson.operationalLayers)[0])
    expect(layer.id).toBe('roads-sublayer-0')
    expect(layer).not.toHaveProperty('url')
  })

  it('preserves the wrong saved layer type error without reading feature chunks', async () => {
    mocks.getLayerSnapshots.mockResolvedValue([createSnapshot('changed-layer')])
    const packageRecord = createPackage({
      operationalLayers: [{
        id: 'changed-layer',
        layerType: 'ArcGISTiledMapServiceLayer',
      }],
      version: '2.30',
    })

    await expect(buildOfflineWebMap(packageRecord)).rejects.toThrow(
      'Saved layer changed-layer is no longer a feature layer.',
    )
    expect(mocks.fromJSON).not.toHaveBeenCalled()
    expect(mocks.getFeatureChunks).not.toHaveBeenCalled()
  })

  it('produces a locally loadable WebMap with embedded saved features', async () => {
    vi.resetModules()
    vi.doUnmock('@arcgis/core/WebMap.js')
    const { buildOfflineWebMap: buildWithArcGis } = await import('./offline-map-builder.ts')
    mocks.getLayerSnapshots.mockResolvedValue([createSnapshot('saved-feature')])
    mocks.getFeatureChunks.mockResolvedValue([{
      chunkId: 'saved-feature:0',
      features: [{
        attributes: { OBJECTID: 7 },
        geometry: { x: -80, y: 35 },
      }],
      index: 0,
      layerId: 'saved-feature',
      packageId: 'test-package',
    }])
    const packageRecord = createPackage({
      operationalLayers: [{
        id: 'saved-feature',
        layerType: 'ArcGISFeatureLayer',
        title: 'Saved feature',
        url: 'https://example.com/FeatureServer/1',
      }],
      version: '2.30',
    })

    const map = await buildWithArcGis(packageRecord)
    await map.load()

    const layer = map.layers.at(0) as FeatureLayer
    expect(layer.type).toBe('feature')
    expect(layer.url).toBeNull()
    expect(layer.source.length).toBe(1)
    expect(layer.source.at(0)?.attributes).toEqual({ OBJECTID: 7 })
  })
})
