import { describe, expect, it } from 'vitest'
import type { JsonObject } from '../../../shared/arcgis/index.ts'
import { VIDEO_CAPTURE_FRAME_RATE, type VideoDraftView } from '../types.ts'
import {
  calculateTransitionFrameCounts,
  calculateTransitionDurationMs,
  createVideoTimeline,
  easeInOutCubic,
  interpolatePanViewpoint,
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
  it('uses a 24 FPS capture rate and ease-in-out progress with exact endpoints', () => {
    expect(VIDEO_CAPTURE_FRAME_RATE).toBe(24)
    expect(easeInOutCubic(0)).toBe(0)
    expect(easeInOutCubic(0.25)).toBeLessThan(0.25)
    expect(easeInOutCubic(0.5)).toBe(0.5)
    expect(easeInOutCubic(0.75)).toBeGreaterThan(0.75)
    expect(easeInOutCubic(1)).toBe(1)
  })

  it('derives slower pan and cross-fade frame counts directly from 24 FPS', () => {
    const source = makeView('first', 0, 1_000)
    const oneViewportPan = makeView('first', 100, 1_000)
    const counts = calculateTransitionFrameCounts(source, oneViewportPan)

    expect(counts).toEqual({
      pan: Math.round(
        (videoTimingConstants.minimumPanSeconds + videoTimingConstants.panSecondsPerViewportWidth)
        * VIDEO_CAPTURE_FRAME_RATE,
      ),
      zoomCrossFade: 0,
    })
    expect(calculateTransitionDurationMs(source, oneViewportPan)).toBe(
      counts.pan / VIDEO_CAPTURE_FRAME_RATE * 1_000,
    )

    const panAndZoom = calculateTransitionFrameCounts(
      source,
      makeView('first', 100_000, 1_000_000),
    )
    expect(panAndZoom.pan).toBe(
      videoTimingConstants.maximumPanSeconds * VIDEO_CAPTURE_FRAME_RATE,
    )
    expect(panAndZoom.zoomCrossFade).toBe(
      videoTimingConstants.maximumZoomSeconds * VIDEO_CAPTURE_FRAME_RATE,
    )
  })

  it('ease-in-out interpolates pan and rotation while preserving source zoom', () => {
    const source = makeView('first', 0, 1_000).viewpoint
    const destination = makeView('second', 100, 4_000).viewpoint
    const midpoint = interpolatePanViewpoint(source, destination, 0.5)

    expect(midpoint.scale).toBe(1_000)
    expect(midpoint.rotation).toBeCloseTo(0)
    expect(midpoint.targetGeometry).toMatchObject({ x: 50, y: 0 })
  })

  it('creates pan frames before zoom cross-fades and longer final-view holds', () => {
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
    expect(timeline.scenes[0].holdEndMs - timeline.scenes[0].holdStartMs).toBeCloseTo(3_000)

    const transitionFrames = timeline.frames.filter((frame) => frame.sceneId === undefined)
    const firstZoomFrameIndex = transitionFrames.findIndex(
      (frame) => frame.phase === 'zoom-crossfade',
    )
    expect(firstZoomFrameIndex).toBeGreaterThan(0)
    expect(
      transitionFrames.slice(0, firstZoomFrameIndex).every((frame) => frame.phase === 'pan'),
    ).toBe(true)
    expect(
      transitionFrames.slice(firstZoomFrameIndex).every(
        (frame) => frame.phase === 'zoom-crossfade',
      ),
    ).toBe(true)
    expect(transitionFrames[firstZoomFrameIndex].crossFadeProgress).toBeGreaterThan(0)
    expect(transitionFrames.at(-1)?.crossFadeProgress).toBe(1)
  })

  it('keeps source layers during pan and switches them for the zoom cross-fade', () => {
    const timeline = createVideoTimeline([
      makeView('first', 0, 1_000),
      makeView('second', 200, 2_000),
    ])

    const transitionFrames = timeline.frames.filter((frame) => frame.sceneId === undefined)
    expect(transitionFrames.length).toBeGreaterThan(1)
    const panFrames = transitionFrames.filter((frame) => frame.phase === 'pan')
    const zoomFrames = transitionFrames.filter((frame) => frame.phase === 'zoom-crossfade')
    expect(panFrames.every((frame) => frame.layers[0]?.visible)).toBe(true)
    expect(zoomFrames.every((frame) => !frame.layers[0]?.visible)).toBe(true)
    expect(timeline.frames.at(-1)?.sceneId).toBe('second')
  })

  it('requires valid views and interpolation progress', () => {
    expect(() => createVideoTimeline([])).toThrow('at least one')
    expect(() => interpolatePanViewpoint(
      makeView('first', 0, 1_000).viewpoint,
      makeView('second', 1, 1_000).viewpoint,
      2,
    )).toThrow('between zero and one')

    const invalid: JsonObject = { scale: 1_000 }
    expect(() => interpolatePanViewpoint(invalid, invalid, 0.5)).toThrow('target geometry')
  })
})
