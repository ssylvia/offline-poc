import Extent from '@arcgis/core/geometry/Extent.js'
import * as projectOperator from '@arcgis/core/geometry/operators/projectOperator.js'
import type FeatureLayer from '@arcgis/core/layers/FeatureLayer.js'
import type TileLayer from '@arcgis/core/layers/TileLayer.js'
import type VectorTileLayer from '@arcgis/core/layers/VectorTileLayer.js'
import type WebTileLayer from '@arcgis/core/layers/WebTileLayer.js'
import type TileInfo from '@arcgis/core/layers/support/TileInfo.js'
import { getPortalResourceUrls } from '../arcgis/portal.ts'
import {
  serializeExtent,
  type FeatureDownloadPlan,
  type JsonObject,
  type LayerCompatibility,
  type LiveMapSession,
  type PreflightReport,
  type TileResource,
} from '../types.ts'
import {
  bufferExtent,
  enumerateTileCoordinates,
  selectDownloadLevels,
  type TileGrid,
} from './coverage.ts'

const averageRasterTileBytes = 40 * 1024
const averageVectorTileBytes = 18 * 1024
const averageFeatureBytes = 1_500
const packageOverheadBytes = 2 * 1024 * 1024

function tileInfoToGrid(tileInfo: TileInfo): TileGrid {
  return {
    lods: tileInfo.lods.map((lod) => ({
      level: lod.level,
      resolution: lod.resolution,
      scale: lod.scale,
    })),
    origin: {
      x: tileInfo.origin.x,
      y: tileInfo.origin.y,
    },
    size: tileInfo.size,
  }
}

async function projectExtent(
  extent: Extent,
  spatialReference: TileInfo['spatialReference'],
): Promise<Extent> {
  if (extent.spatialReference.equals(spatialReference)) {
    return extent
  }
  if (!projectOperator.isLoaded()) {
    await projectOperator.load()
  }
  const projected = projectOperator.execute(extent, spatialReference)
  if (!projected || projected.type !== 'extent') {
    throw new Error('The download extent could not be projected to this tile layer.')
  }
  return projected
}

function vectorStyleResources(layer: VectorTileLayer): string[] {
  const info = layer.currentStyleInfo
  const resources = new Set<string>()

  if (info.styleUrl) {
    resources.add(info.styleUrl)
  }
  if (info.serviceUrl) {
    resources.add(`${info.serviceUrl.replace(/\/$/, '')}?f=json`)
  }
  if (info.spriteUrl) {
    const base = info.spriteUrl.replace(/\.(json|png)$/i, '')
    resources.add(`${base}.json`)
    resources.add(`${base}.png`)
    resources.add(`${base}@2x.json`)
    resources.add(`${base}@2x.png`)
  }

  if (info.glyphsUrl) {
    const style = info.style as {
      layers?: Array<{ layout?: { 'text-font'?: unknown } }>
    }
    const fontStacks = new Set<string>()
    for (const styleLayer of style.layers ?? []) {
      const fonts = styleLayer.layout?.['text-font']
      if (Array.isArray(fonts) && fonts.every((font) => typeof font === 'string')) {
        fontStacks.add(fonts.join(','))
      }
    }

    for (const fontStack of fontStacks) {
      for (const range of ['0-255', '256-511']) {
        resources.add(
          info.glyphsUrl
            .replace('{fontstack}', encodeURIComponent(fontStack))
            .replace('{range}', range),
        )
      }
    }
  }

  return [...resources]
}

function observedArcGisResources(hostnames: Set<string>): string[] {
  return performance
    .getEntriesByType('resource')
    .map((entry) => entry.name)
    .filter((value) => {
      try {
        const url = new URL(value)
        return url.protocol === 'https:'
          && (hostnames.has(url.hostname) || url.hostname.endsWith('.arcgis.com'))
          && !url.searchParams.has('token')
      } catch {
        return false
      }
    })
}

function hasEmbeddedCredential(url: string | null | undefined): boolean {
  if (!url) {
    return false
  }
  try {
    const parsed = new URL(url)
    return parsed.searchParams.has('token') || parsed.searchParams.has('apiKey')
  } catch {
    return false
  }
}

function unsupportedResult(
  id: string,
  title: string,
  type: string,
  message: string,
): LayerCompatibility {
  return { id, level: 'unsupported', message, title, type }
}

export async function createPreflightReport(
  session: LiveMapSession,
  signal?: AbortSignal,
): Promise<PreflightReport> {
  if (!session.view.extent) {
    throw new Error('Wait for the map extent to finish loading before downloading.')
  }

  const viewExtent = bufferExtent(serializeExtent(session.view.extent))
  const coverageGeometry = Extent.fromJSON(viewExtent)
  const resourceUrls: TileResource[] = getPortalResourceUrls(session.item).map((url) => ({
    layerId: 'portal-item',
    url,
  }))
  const featurePlans: FeatureDownloadPlan[] = []
  const layerResults: LayerCompatibility[] = []
  const allLevels = new Set<number>()
  const knownHostnames = new Set<string>(['www.arcgis.com'])
  let estimatedBytes = packageOverheadBytes

  for (const [layerIndex, layer] of session.map.allLayers.toArray().entries()) {
    signal?.throwIfAborted()
    const layerId = layer.id ?? `layer-${layerIndex}`
    const title = layer.title ?? layerId
    const type = layer.type ?? 'unknown'
    const url = 'url' in layer && typeof layer.url === 'string' ? layer.url : undefined

    if (url) {
      try {
        knownHostnames.add(new URL(url).hostname)
      } catch {
        layerResults.push(unsupportedResult(
          layerId,
          title,
          type,
          'The layer URL is invalid.',
        ))
        continue
      }
    }

    if (hasEmbeddedCredential(url)) {
      layerResults.push(unsupportedResult(
        layerId,
        title,
        type,
        'Credential-bearing layer URLs are not retained by this public-map prototype.',
      ))
      continue
    }

    try {
      await layer.load()
      signal?.throwIfAborted()

      if (type === 'group') {
        layerResults.push({
          id: layerId,
          level: 'supported',
          message: 'Layer grouping and order will be retained.',
          title,
          type,
        })
        continue
      }

      if (type === 'graphics') {
        layerResults.push({
          id: layerId,
          level: 'supported',
          message: 'Embedded graphics are already part of the WebMap snapshot.',
          title,
          type,
        })
        continue
      }

      if (type === 'feature') {
        const featureLayer = layer as FeatureLayer
        const query = featureLayer.createQuery()
        query.geometry = coverageGeometry
        query.spatialRelationship = 'intersects'
        const featureCount = await featureLayer.queryFeatureCount(query, { signal })
        featurePlans.push({
          featureCount,
          layer,
          layerId,
          title,
        })
        estimatedBytes += featureCount * averageFeatureBytes
        layerResults.push({
          featureCount,
          id: layerId,
          level: 'supported',
          message: `${featureCount.toLocaleString()} intersecting features will be copied locally.`,
          title,
          type,
        })
        continue
      }

      if (type === 'tile' || type === 'web-tile') {
        const tileLayer = layer as TileLayer | WebTileLayer
        const serviceUrl = type === 'tile' ? (tileLayer as TileLayer).url : undefined
        if (serviceUrl) {
          resourceUrls.push({
            layerId,
            url: `${serviceUrl.replace(/\/$/, '')}?f=json`,
          })
        }
        const levels = selectDownloadLevels(
          tileInfoToGrid(tileLayer.tileInfo).lods,
          session.view.scale,
        )
        const projectedExtent = await projectExtent(coverageGeometry, tileLayer.tileInfo.spatialReference)
        const boundedExtent = tileLayer.fullExtent
          ? projectedExtent.intersection(tileLayer.fullExtent) ?? projectedExtent
          : projectedExtent
        const coordinates = enumerateTileCoordinates(
          tileInfoToGrid(tileLayer.tileInfo),
          serializeExtent(boundedExtent),
          levels,
        )
        for (const coordinate of coordinates) {
          const tileUrl = tileLayer.getTileUrl(coordinate.level, coordinate.row, coordinate.col)
          if (tileUrl) {
            resourceUrls.push({
              layerId,
              level: coordinate.level,
              url: tileUrl,
            })
          }
        }
        levels.forEach((level) => allLevels.add(level))
        estimatedBytes += coordinates.length * averageRasterTileBytes
        layerResults.push({
          id: layerId,
          level: 'supported',
          message: `${coordinates.length.toLocaleString()} raster tiles will be cached.`,
          resourceCount: coordinates.length,
          title,
          type,
        })
        continue
      }

      if (type === 'vector-tile') {
        const vectorLayer = layer as VectorTileLayer
        const levels = selectDownloadLevels(
          tileInfoToGrid(vectorLayer.tileInfo).lods,
          session.view.scale,
        )
        const projectedExtent = await projectExtent(coverageGeometry, vectorLayer.tileInfo.spatialReference)
        const coordinates = enumerateTileCoordinates(
          tileInfoToGrid(vectorLayer.tileInfo),
          serializeExtent(projectedExtent),
          levels,
        )
        const serviceUrl = vectorLayer.currentStyleInfo.serviceUrl ?? vectorLayer.url
        if (!serviceUrl) {
          throw new Error('The vector tile service URL is unavailable.')
        }
        for (const coordinate of coordinates) {
          resourceUrls.push({
            layerId,
            level: coordinate.level,
            url: `${serviceUrl.replace(/\/$/, '')}/tile/${coordinate.level}/${coordinate.row}/${coordinate.col}.pbf`,
          })
        }
        for (const styleUrl of vectorStyleResources(vectorLayer)) {
          resourceUrls.push({ layerId, url: styleUrl })
        }
        levels.forEach((level) => allLevels.add(level))
        estimatedBytes += coordinates.length * averageVectorTileBytes
        layerResults.push({
          id: layerId,
          level: 'degraded',
          message: `${coordinates.length.toLocaleString()} vector tiles and common Latin glyph ranges will be cached. Other glyph ranges are available only if observed in the live view.`,
          resourceCount: coordinates.length,
          title,
          type,
        })
        continue
      }

      layerResults.push(unsupportedResult(
        layerId,
        title,
        type,
        `Layer type “${type}” cannot be reconstructed reliably by this prototype.`,
      ))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The layer could not be inspected.'
      layerResults.push(unsupportedResult(
        layerId,
        title,
        type,
        `Compatibility check failed: ${message}`,
      ))
    }
  }

  for (const url of observedArcGisResources(knownHostnames)) {
    resourceUrls.push({ layerId: 'observed-live-resource', url })
  }

  const uniqueResources = [...new Map(
    resourceUrls
      .filter((resource) => !hasEmbeddedCredential(resource.url))
      .map((resource) => [resource.url, resource]),
  ).values()]

  return {
    coverageExtent: viewExtent,
    estimatedBytes,
    featurePlans,
    generatedAt: Date.now(),
    hasLimitations: layerResults.some((result) => result.level !== 'supported'),
    layerResults,
    levels: [...allLevels].sort((left, right) => left - right),
    resourceUrls: uniqueResources,
  }
}

export function snapshotWebMapJson(session: LiveMapSession): JsonObject {
  return structuredClone(session.itemData)
}
