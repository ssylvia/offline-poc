import { describe, expect, it } from 'vitest'
import { applyLayerStates } from './view-state.ts'

describe('offline video view state', () => {
  it('validates every captured layer before mutating the map', () => {
    const firstLayer = {
      id: 'layer-1',
      opacity: 0.25,
      title: 'Layer 1',
      visible: false,
    }
    const map = {
      allLayers: {
        toArray: () => [firstLayer],
      },
    }

    expect(() => applyLayerStates(map as never, [
      {
        id: 'layer-1',
        opacity: 1,
        title: 'Layer 1',
        visible: true,
      },
      {
        id: 'missing-layer',
        opacity: 0.5,
        title: 'Missing layer',
        visible: false,
      },
    ])).toThrow('Missing layer')

    expect(firstLayer).toMatchObject({
      opacity: 0.25,
      visible: false,
    })
  })
})
