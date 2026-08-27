import { describe, expect, it } from 'vitest'
import { canonicalizeOfflineResourceUrl } from './offline-resource-url.ts'

describe('offline ArcGIS resource URLs', () => {
  it('matches portal style resources rewritten to the ArcGIS CDN', () => {
    const itemPath = '/sharing/rest/content/items/item-id/resources/styles/root.json'

    expect(canonicalizeOfflineResourceUrl(`https://www.arcgis.com${itemPath}`)).toBe(
      canonicalizeOfflineResourceUrl(`https://cdn.arcgis.com${itemPath}?f=json`),
    )
  })

  it('retains meaningful query parameters in deterministic order', () => {
    expect(canonicalizeOfflineResourceUrl(
      'https://services.arcgis.com/tiles/1?tokenless=true&level=4#fragment',
    )).toBe(
      'https://services.arcgis.com/tiles/1?level=4&tokenless=true',
    )
  })
})
