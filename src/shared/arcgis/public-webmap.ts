import type WebMap from '@arcgis/core/WebMap.js'
import type MapView from '@arcgis/core/views/MapView.js'
import type { JsonObject } from './json.ts'

const portalRoot = 'https://www.arcgis.com/sharing/rest'

export interface PortalItemInfo {
  access: string
  id: string
  modified: number
  owner: string
  snippet?: string
  thumbnail?: string
  title: string
  type: string
}

export interface LiveMapSession {
  item: PortalItemInfo
  itemData: JsonObject
  map: WebMap
  view: MapView
}

interface ArcGisErrorResponse {
  error?: {
    code?: number
    message?: string
  }
}

function getPortalError(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || !('error' in value)) {
    return undefined
  }

  const response = value as ArcGisErrorResponse
  return response.error?.message ?? 'ArcGIS returned an unknown portal error.'
}

function isPortalItemInfo(value: unknown): value is PortalItemInfo {
  if (!value || typeof value !== 'object') {
    return false
  }

  const item = value as Partial<PortalItemInfo>
  return typeof item.id === 'string'
    && typeof item.title === 'string'
    && typeof item.type === 'string'
    && typeof item.owner === 'string'
    && typeof item.access === 'string'
    && typeof item.modified === 'number'
}

export async function loadPublicWebMapItem(
  itemId: string,
  signal: AbortSignal,
): Promise<{ item: PortalItemInfo; itemData: JsonObject }> {
  const itemResponse = await fetch(`${portalRoot}/content/items/${itemId}?f=json`, { signal })
  if (!itemResponse.ok) {
    throw new Error(`ArcGIS item lookup failed with HTTP ${itemResponse.status}.`)
  }

  const itemValue: unknown = await itemResponse.json()
  const itemError = getPortalError(itemValue)
  if (itemError) {
    throw new Error(`ArcGIS could not load this item: ${itemError}`)
  }
  if (!isPortalItemInfo(itemValue)) {
    throw new Error('ArcGIS returned incomplete item metadata.')
  }
  if (itemValue.type !== 'Web Map') {
    throw new Error(`Item ${itemId} is a “${itemValue.type}”, not an ArcGIS Web Map.`)
  }
  if (itemValue.access !== 'public') {
    throw new Error('This prototype only supports WebMaps shared publicly.')
  }

  const dataResponse = await fetch(`${portalRoot}/content/items/${itemId}/data?f=json`, { signal })
  if (!dataResponse.ok) {
    throw new Error(`ArcGIS WebMap data lookup failed with HTTP ${dataResponse.status}.`)
  }
  const itemDataValue: unknown = await dataResponse.json()
  const dataError = getPortalError(itemDataValue)
  if (dataError) {
    throw new Error(`ArcGIS could not load this WebMap data: ${dataError}`)
  }
  if (!itemDataValue || typeof itemDataValue !== 'object' || Array.isArray(itemDataValue)) {
    throw new Error('ArcGIS returned invalid WebMap data.')
  }

  return {
    item: itemValue,
    itemData: itemDataValue as JsonObject,
  }
}

export function getPortalThumbnailUrl(item: PortalItemInfo): string | undefined {
  if (!item.thumbnail) {
    return undefined
  }
  return `${portalRoot}/content/items/${item.id}/info/${encodeURIComponent(item.thumbnail)}`
}

export function getPortalResourceUrls(item: PortalItemInfo): string[] {
  const base = `${portalRoot}/content/items/${item.id}`
  const thumbnailUrl = getPortalThumbnailUrl(item)
  return [
    `${base}?f=json`,
    `${base}/data?f=json`,
    ...(thumbnailUrl ? [thumbnailUrl] : []),
  ]
}
