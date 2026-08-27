import { describe, expect, it } from 'vitest'
import type { JsonObject } from '../../../shared/arcgis/index.ts'
import { VIDEO_CAPTURE_FRAME_RATE, type VideoDraftView } from '../types.ts'
import {
  calculateTransitionDurationMs,
  createVideoTimeline,
  easeElasticPan,
  easeInOutCubic,
  interpolateViewpoint,
  videoTimingConstants,
} from './timeline.ts'

function makeView(
  id: string,
  x: number,
  scale: number,
  extentWidth = 100,
): VideoDraftView {
  return {
    capturedAt: 1,
    extent: {
      xmin: x - extentWidth / 2,
      ymin: -50,
      xmax: x + extentWidth / 2,
      ymax: 50,
    },
    id,
    layers: [{
      id: 'layer-1',
      opacity: 1,
      title: 'Layer',
      visible: id === 'first',
    }],
    name: id,
    thumbnailBlob: new Blob(['thumbnail']),
    viewpoint: {
      rotation: id === 'first' ? 350 : 10,
      scale,
      targetGeometry: { x, y: 0 },
    },
  }
}

describe('offline video timeline', () => {
  it('uses a 24 FPS capture rate and bounded easing with exact endpoints', () => {
    expect(VIDEO_CAPTURE_FRAME_RATE).toBe(24)
    const elasticProgress = Array.from({ length: 101 }, (_, index) => easeElasticPan(index / 100))
    expect(elasticProgress[0]).toBe(0)
    expect(elasticProgress.at(-1)).toBe(1)
    expect(elasticProgress.every((value) => value >= -0.04 && value <= 1.04)).toBe(true)
    expect(easeInOutCubic(0)).toBe(0)
    expect(easeInOutCubic(0.5)).toBe(0.5)
    expect(easeInOutCubic(1)).toBe(1)
  })

  it('scales transition duration by pan and zoom with bounded output', () => {
    const source = makeView('first', 0, 1_000)
    expect(calculateTransitionDurationMs(source, makeView('nearby', 0, 1_000))).toBe(
      videoTimingConstants.minimumTransitionMs,
    )
    expect(calculateTransitionDurationMs(source, makeView('far', 100_000, 1_000_000))).toBe(
      videoTimingConstants.maximumTransitionMs,
    )
  })

  it('interpolates center, scale, and the shortest rotation direction', () => {
    const source = makeView('first', 0, 1_000).viewpoint
    const destination = makeView('second', 100, 4_000).viewpoint
    const midpoint = interpolateViewpoint(source, destination, 0.5)

    expect(midpoint.scale).toBeCloseTo(2_000)
    expect(midpoint.rotation).toBeCloseTo(0)
    expect(midpoint.targetGeometry).toMatchObject({ x: 50, y: 0 })
  })

  it('creates monotonic seek points inside final-view holds', () => {
    const timeline = createVideoTimeline([
      makeView('first', 0, 1_000),
      makeView('second', 200, 2_000),
    ])

    expect(timeline.scenes).toHaveLength(2)
    expect(timeline.frames.every((frame, index) => frame.index === index)).toBe(true)
    expect(timeline.scenes[0].timestampMs).toBeGreaterThan(timeline.scenes[0].holdStartMs)
    expect(timeline.scenes[0].timestampMs).toBeLessThan(timeline.scenes[0].holdEndMs)
    expect(timeline.scenes[1].timestampMs).toBeGreaterThan(timeline.scenes[0].timestampMs)
    expect(timeline.scenes[1].holdEndMs).toBe(timeline.durationMs)
    expect(timeline.frames.some((frame) => frame.sceneId === undefined)).toBe(true)
  })

  it('switches layer states once during a transition before the destination hold', () => {
    const timeline = createVideoTimeline([
      makeView('first', 0, 1_000),
      makeView('second', 200, 2_000),
    ])

    const transitionFrames = timeline.frames.filter((frame) => frame.sceneId === undefined)
    expect(transitionFrames.length).toBeGreaterThan(1)
    expect(transitionFrames[0].layers[0]?.visible).toBe(true)
    expect(transitionFrames.at(-1)?.layers[0]?.visible).toBe(false)
    expect(timeline.frames.at(-1)?.sceneId).toBe('second')
  })

  it('requires valid views and interpolation progress', () => {
    expect(() => createVideoTimeline([])).toThrow('at least one')
    expect(() => interpolateViewpoint(
      makeView('first', 0, 1_000).viewpoint,
      makeView('second', 1, 1_000).viewpoint,
      2,
    )).toThrow('between zero and one')

    const invalid: JsonObject = { scale: 1_000 }
    expect(() => interpolateViewpoint(invalid, invalid, 0.5)).toThrow('target geometry')
  })
})
