import type { SerializedExtent } from '../types.ts'

export interface TileGrid {
  lods: Array<{ level: number; resolution: number; scale: number }>
  origin: { x: number; y: number }
  size: number[]
}

export interface TileCoordinate {
  col: number
  level: number
  row: number
}

export function bufferExtent(extent: SerializedExtent, factor = 1.25): SerializedExtent {
  const widthPadding = (extent.xmax - extent.xmin) * (factor - 1) / 2
  const heightPadding = (extent.ymax - extent.ymin) * (factor - 1) / 2

  return {
    ...extent,
    xmin: extent.xmin - widthPadding,
    ymin: extent.ymin - heightPadding,
    xmax: extent.xmax + widthPadding,
    ymax: extent.ymax + heightPadding,
  }
}

export function selectDownloadLevels(
  lods: TileGrid['lods'],
  viewScale: number,
  additionalLevels = 2,
): number[] {
  if (lods.length === 0) {
    return []
  }

  const closestIndex = lods.reduce((bestIndex, lod, index) => {
    const bestDifference = Math.abs(Math.log(lods[bestIndex].scale / viewScale))
    const difference = Math.abs(Math.log(lod.scale / viewScale))
    return difference < bestDifference ? index : bestIndex
  }, 0)

  return lods
    .slice(closestIndex, closestIndex + additionalLevels + 1)
    .map((lod) => lod.level)
}

export function enumerateTileCoordinates(
  tileGrid: TileGrid,
  extent: SerializedExtent,
  levels: number[],
): TileCoordinate[] {
  const [tileWidth = 256, tileHeight = tileWidth] = tileGrid.size
  const coordinates: TileCoordinate[] = []

  for (const level of levels) {
    const lod = tileGrid.lods.find((candidate) => candidate.level === level)
    if (!lod) {
      continue
    }

    const mapTileWidth = tileWidth * lod.resolution
    const mapTileHeight = tileHeight * lod.resolution
    const minCol = Math.floor((extent.xmin - tileGrid.origin.x) / mapTileWidth)
    const maxCol = Math.ceil((extent.xmax - tileGrid.origin.x) / mapTileWidth) - 1
    const minRow = Math.floor((tileGrid.origin.y - extent.ymax) / mapTileHeight)
    const maxRow = Math.ceil((tileGrid.origin.y - extent.ymin) / mapTileHeight) - 1

    for (let row = minRow; row <= maxRow; row += 1) {
      for (let col = minCol; col <= maxCol; col += 1) {
        if (row >= 0 && col >= 0) {
          coordinates.push({ col, level, row })
        }
      }
    }
  }

  return coordinates
}
