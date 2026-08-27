import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SavedMapPackage } from '../types.ts'
import {
  activatePackageCache,
  deactivatePackageCache,
} from './service-worker-client.ts'

const packageRecord: SavedMapPackage = {
  byteSize: 1,
  cacheName: 'offline-map-cache',
  compatibility: [],
  coverageExtent: {
    spatialReference: { wkid: 4326 },
    xmax: 1,
    xmin: 0,
    ymax: 1,
    ymin: 0,
  },
  createdAt: 1,
  featureCount: 0,
  item: {
    access: 'public',
    id: 'a'.repeat(32),
    modified: 1,
    owner: 'owner',
    title: 'Offline map',
    type: 'Web Map',
  },
  itemData: {},
  levels: [],
  packageId: 'package-1',
  resourceCount: 0,
  resources: [],
  sdkVersion: 'test',
  state: 'complete',
  viewpoint: {},
  webMapJson: {},
}

describe('offline package service-worker client', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses activation IDs so cleanup only releases its own package activation', async () => {
    const postMessage = vi.fn((
      _message: unknown,
      ports?: Transferable[],
    ) => {
      const responsePort = ports?.[0]
      if (responsePort instanceof MessagePort) {
        responsePort.postMessage({ activated: true })
      }
    })
    const worker = { postMessage }
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        controller: worker,
        ready: Promise.resolve({ active: worker }),
      },
    })
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      '11111111-1111-4111-8111-111111111111',
    )

    const activationId = await activatePackageCache(packageRecord)
    deactivatePackageCache(activationId)

    expect(activationId).toBe('11111111-1111-4111-8111-111111111111')
    expect(postMessage).toHaveBeenNthCalledWith(
      1,
      {
        activationId,
        activationSequence: expect.any(Number),
        source: {
          cacheName: packageRecord.cacheName,
          kind: 'cache',
          resources: [],
        },
        type: 'ACTIVATE_PACKAGE_CACHE',
      },
      [expect.any(MessagePort)],
    )
    expect(postMessage).toHaveBeenNthCalledWith(2, {
      activationId,
      type: 'DEACTIVATE_PACKAGE_CACHE',
    })
  })
})
