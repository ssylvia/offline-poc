import { defaultMapApproachId, isMapApproachId } from '../approaches/index.ts'
import type { MapApproachId } from '../approaches/types.ts'

export const WEBMAP_ID_PATTERN = /^[a-f0-9]{32}$/i

export type ViewerMode = 'live' | 'offline'

export interface UrlState {
  approachId: MapApproachId
  mode: ViewerMode
  savedVideoPackageId?: string
  webmapId?: string
}

export function normalizeWebMapId(value: string): string | undefined {
  const normalized = value.trim()
  return WEBMAP_ID_PATTERN.test(normalized) ? normalized.toLowerCase() : undefined
}

function normalizeOptionalQueryValue(value: string | null): string | undefined {
  const normalized = value?.trim() ?? ''
  return normalized === '' ? undefined : normalized
}

export function readUrlState(search: string): UrlState {
  const params = new URLSearchParams(search)
  const approachParam = params.get('approach')
  const approachId = isMapApproachId(approachParam) ? approachParam : defaultMapApproachId
  const webmapId = normalizeWebMapId(params.get('webmap') ?? '')
  const savedVideoPackageId = normalizeOptionalQueryValue(params.get('video-package'))

  return {
    approachId,
    mode: approachId === 'offline-video' && savedVideoPackageId
      ? 'offline'
      : approachId === defaultMapApproachId && params.get('view') === 'offline'
        ? 'offline'
        : 'live',
    savedVideoPackageId: approachId === 'offline-video' ? savedVideoPackageId : undefined,
    webmapId,
  }
}

export function createUrl(state: UrlState, currentUrl = window.location.href): URL {
  const url = new URL(currentUrl)

  if (state.webmapId) {
    url.searchParams.set('webmap', state.webmapId)
  } else {
    url.searchParams.delete('webmap')
  }

  if (state.approachId === defaultMapApproachId) {
    url.searchParams.delete('approach')
  } else {
    url.searchParams.set('approach', state.approachId)
  }

  if (state.approachId === defaultMapApproachId && state.mode === 'offline') {
    url.searchParams.set('view', 'offline')
  } else {
    url.searchParams.delete('view')
  }

  if (state.approachId === 'offline-video' && state.savedVideoPackageId) {
    url.searchParams.set('video-package', state.savedVideoPackageId)
  } else {
    url.searchParams.delete('video-package')
  }

  return url
}
