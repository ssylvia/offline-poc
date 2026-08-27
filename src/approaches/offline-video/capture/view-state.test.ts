import { describe, expect, it } from 'vitest'
import { applyLayerStates, dataUrlToBlob } from './view-state.ts'

describe('offline video view state', () => {
  it('decodes base64 and percent-encoded screenshot data without fetching', async () => {
    const png = dataUrlToBlob('data:image/png;base64,aGVsbG8=')
    const text = dataUrlToBlob('data:text/plain,hello%20world')

    expect(png.type).toBe('image/png')
    expect(await png.text()).toBe('hello')
    expect(await text.text()).toBe('hello world')
  })

  it('rejects malformed screenshot data URLs', () => {
    expect(() => dataUrlToBlob('https://example.test/frame.png')).toThrow('valid data URL')
    expect(() => dataUrlToBlob('data:image/png;base64,%%%')).toThrow('could not be decoded')
  })

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
