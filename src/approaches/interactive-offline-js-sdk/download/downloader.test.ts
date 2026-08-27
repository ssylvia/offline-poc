import { describe, expect, it, vi } from 'vitest'
import { findMissingCachedResourceUrls } from './downloader.ts'

describe('offline map resource verification', () => {
  it('accepts distinct source URLs that resolve to one Cache Storage key', async () => {
    const storedUrl = 'https://example.test/style.json'
    const cache = {
      match: vi.fn(async (request: Request) => (
        request.url === storedUrl ? new Response('{}') : undefined
      )),
    }

    await expect(findMissingCachedResourceUrls(cache, [
      'https://example.test/style.json#first',
      'https://example.test/style.json#second',
    ])).resolves.toEqual([])
    expect(cache.match).toHaveBeenCalledTimes(2)
  })

  it('reports only resources that cannot be read back', async () => {
    const cache = {
      match: vi.fn(async (request: Request) => (
        request.url.endsWith('/available') ? new Response('ok') : undefined
      )),
    }

    await expect(findMissingCachedResourceUrls(cache, [
      'https://example.test/available',
      'https://example.test/missing',
    ])).resolves.toEqual(['https://example.test/missing'])
  })
})
