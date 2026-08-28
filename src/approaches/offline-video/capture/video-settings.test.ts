import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VIDEO_OUTPUT_SIZE,
  isVideoOutputSizeValid,
  validateVideoOutputSize,
} from './video-settings.ts'

describe('video output settings', () => {
  it('defaults to a fixed full-HD capture viewport', () => {
    expect(DEFAULT_VIDEO_OUTPUT_SIZE).toEqual({ height: 1_080, width: 1_920 })
    expect(isVideoOutputSizeValid(DEFAULT_VIDEO_OUTPUT_SIZE)).toBe(true)
  })

  it('requires bounded even encoder dimensions', () => {
    expect(isVideoOutputSizeValid({ height: 721, width: 1_280 })).toBe(false)
    expect(isVideoOutputSizeValid({ height: 2_160, width: 3_840 })).toBe(true)
    expect(() => validateVideoOutputSize({ height: 100, width: 100 })).toThrow(
      'even dimensions',
    )
  })
})
