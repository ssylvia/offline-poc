import type { VideoOutputSize } from '../types.ts'

export const DEFAULT_VIDEO_OUTPUT_SIZE: VideoOutputSize = {
  height: 1_080,
  width: 1_920,
}

export const VIDEO_OUTPUT_SIZE_LIMITS = {
  maximumHeight: 2_160,
  maximumWidth: 3_840,
  minimumHeight: 360,
  minimumWidth: 640,
} as const

export function isVideoOutputSizeValid(size: VideoOutputSize): boolean {
  return Number.isInteger(size.width)
    && Number.isInteger(size.height)
    && size.width % 2 === 0
    && size.height % 2 === 0
    && size.width >= VIDEO_OUTPUT_SIZE_LIMITS.minimumWidth
    && size.width <= VIDEO_OUTPUT_SIZE_LIMITS.maximumWidth
    && size.height >= VIDEO_OUTPUT_SIZE_LIMITS.minimumHeight
    && size.height <= VIDEO_OUTPUT_SIZE_LIMITS.maximumHeight
}

export function validateVideoOutputSize(size: VideoOutputSize): VideoOutputSize {
  if (!isVideoOutputSizeValid(size)) {
    throw new Error(
      `Video size must use even dimensions between ${
        VIDEO_OUTPUT_SIZE_LIMITS.minimumWidth
      }×${VIDEO_OUTPUT_SIZE_LIMITS.minimumHeight} and ${
        VIDEO_OUTPUT_SIZE_LIMITS.maximumWidth
      }×${VIDEO_OUTPUT_SIZE_LIMITS.maximumHeight} pixels.`,
    )
  }
  return { height: size.height, width: size.width }
}
