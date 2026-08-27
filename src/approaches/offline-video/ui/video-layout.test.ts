import { describe, expect, it } from 'vitest'
import { getContainedMediaRect } from './video-layout.ts'

describe('contained video layout', () => {
  it('accounts for vertical letterboxing', () => {
    expect(getContainedMediaRect(1_000, 1_000, 1_600, 900)).toEqual({
      height: 562.5,
      left: 0,
      top: 218.75,
      width: 1_000,
    })
  })

  it('accounts for horizontal letterboxing', () => {
    expect(getContainedMediaRect(1_000, 500, 500, 500)).toEqual({
      height: 500,
      left: 250,
      top: 0,
      width: 500,
    })
  })

  it('returns an empty rect for invalid dimensions', () => {
    expect(getContainedMediaRect(0, 500, 500, 500).width).toBe(0)
  })
})
