import { describe, expect, it } from 'vitest'
import { defaultMapApproachId } from '../approaches/index.ts'
import {
  createUrl,
  normalizeWebMapId,
  readUrlState,
} from './url-state.ts'

const itemId = 'A1B2C3D4E5F60718293A4B5C6D7E8F90'

describe('WebMap URL state', () => {
  it('normalizes valid item IDs and rejects malformed values', () => {
    expect(normalizeWebMapId(` ${itemId} `)).toBe(itemId.toLowerCase())
    expect(normalizeWebMapId('not-an-item')).toBeUndefined()
  })

  it('reads a direct offline link', () => {
    expect(readUrlState(`?webmap=${itemId}&view=offline`)).toEqual({
      approachId: defaultMapApproachId,
      mode: 'offline',
      webmapId: itemId.toLowerCase(),
    })
  })

  it('reads an offline video route with an optional saved package ID', () => {
    expect(
      readUrlState(`?approach=offline-video&webmap=${itemId}&video-package=%20capture-001%20`),
    ).toEqual({
      approachId: 'offline-video',
      mode: 'offline',
      savedVideoPackageId: 'capture-001',
      webmapId: itemId.toLowerCase(),
    })
  })

  it('preserves the legacy interactive route shape when creating a viewer URL', () => {
    const url = createUrl(
      {
        approachId: defaultMapApproachId,
        mode: 'offline',
        webmapId: itemId.toLowerCase(),
      },
      'https://example.test/viewer?approach=offline-video&debug=1&video-package=stale',
    )

    expect(url.searchParams.get('debug')).toBe('1')
    expect(url.searchParams.get('approach')).toBeNull()
    expect(url.searchParams.get('video-package')).toBeNull()
    expect(url.searchParams.get('webmap')).toBe(itemId.toLowerCase())
    expect(url.searchParams.get('view')).toBe('offline')
  })

  it('adds an explicit approach ID for offline video routes', () => {
    const url = createUrl(
      {
        approachId: 'offline-video',
        mode: 'offline',
        savedVideoPackageId: 'capture-001',
        webmapId: itemId.toLowerCase(),
      },
      'https://example.test/viewer?debug=1&view=offline',
    )

    expect(url.searchParams.get('debug')).toBe('1')
    expect(url.searchParams.get('approach')).toBe('offline-video')
    expect(url.searchParams.get('video-package')).toBe('capture-001')
    expect(url.searchParams.get('view')).toBeNull()
    expect(url.searchParams.get('webmap')).toBe(itemId.toLowerCase())
  })
})
