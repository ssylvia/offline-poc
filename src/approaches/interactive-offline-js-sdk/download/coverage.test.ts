import { describe, expect, it } from 'vitest'
import {
  bufferExtent,
  enumerateTileCoordinates,
  selectDownloadLevels,
  type TileGrid,
} from './coverage.ts'

const spatialReference = { wkid: 3857 }

describe('offline coverage calculations', () => {
  it('adds a 25 percent extent buffer evenly on all sides', () => {
    expect(bufferExtent({
      xmin: 0,
      ymin: 0,
      xmax: 100,
      ymax: 200,
      spatialReference,
    })).toEqual({
      xmin: -12.5,
      ymin: -25,
      xmax: 112.5,
      ymax: 225,
      spatialReference,
    })
  })

  it('selects the closest level and two more detailed levels', () => {
    expect(selectDownloadLevels([
      { level: 0, resolution: 4, scale: 10_000 },
      { level: 1, resolution: 2, scale: 5_000 },
      { level: 2, resolution: 1, scale: 2_500 },
      { level: 3, resolution: 0.5, scale: 1_250 },
    ], 5_200)).toEqual([1, 2, 3])
  })

  it('enumerates only tiles intersecting the bounded extent', () => {
    const grid: TileGrid = {
      lods: [{ level: 3, resolution: 1, scale: 1_000 }],
      origin: { x: 0, y: 100 },
      size: [10, 10],
    }

    expect(enumerateTileCoordinates(grid, {
      xmin: 0,
      ymin: 80,
      xmax: 20,
      ymax: 100,
      spatialReference,
    }, [3])).toEqual([
      { col: 0, level: 3, row: 0 },
      { col: 1, level: 3, row: 0 },
      { col: 0, level: 3, row: 1 },
      { col: 1, level: 3, row: 1 },
    ])
  })
})
