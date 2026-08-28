import { describe, expect, it } from 'vitest'
import type { JsonObject } from '../../../shared/arcgis/index.ts'
import { VIDEO_CAPTURE_FRAME_RATE, type VideoDraftView } from '../types.ts'
import {
  calculateTransitionFrameCounts,
  calculateTransitionDurationMs,
  createVideoTimeline,
  easeInOutCubic,
  estimateVideoCapture,
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
      layerCrossFade: 0,
      pan: Math.round(
        (videoTimingConstants.minimumPanSeconds + videoTimingConstants.panSecondsPerViewportWidth)
        * VIDEO_CAPTURE_FRAME_RATE,
      ),
      transition: Math.round(
        (videoTimingConstants.minimumPanSeconds + videoTimingConstants.panSecondsPerViewportWidth)
        * VIDEO_CAPTURE_FRAME_RATE,
      ),
      zoomAnimation: 0,
    })
    expect(calculateTransitionDurationMs(source, oneViewportPan)).toBe(
      counts.transition / VIDEO_CAPTURE_FRAME_RATE * 1_000,
    )

    const panAndZoom = calculateTransitionFrameCounts(
      source,
      makeView('first', 100_000, 1_000_000),
    )
    expect(panAndZoom.pan).toBe(
      videoTimingConstants.maximumPanSeconds * VIDEO_CAPTURE_FRAME_RATE,
    )
    expect(panAndZoom.zoomAnimation).toBe(
      videoTimingConstants.maximumZoomSeconds * VIDEO_CAPTURE_FRAME_RATE,
    )
    expect(panAndZoom.layerCrossFade).toBe(0)
  })

  it('normalizes pan timing to the fixed output viewport', () => {
    const narrowSource = makeView('first', 0, 1_000, 100)
    const wideDestination = makeView('first', 100, 1_000, 200)
    narrowSource.mapViewportSize = { height: 300, width: 500 }
    wideDestination.mapViewportSize = { height: 600, width: 1_000 }
    const consistentlyWideSource = makeView('first', 0, 1_000, 200)
    const consistentlyWideDestination = makeView('first', 100, 1_000, 200)
    consistentlyWideSource.mapViewportSize = { height: 600, width: 1_000 }
    consistentlyWideDestination.mapViewportSize = { height: 600, width: 1_000 }
    const outputSize = { height: 720, width: 1_000 }

    expect(calculateTransitionFrameCounts(
      narrowSource,
      wideDestination,
      VIDEO_CAPTURE_FRAME_RATE,
      outputSize,
    )).toEqual(calculateTransitionFrameCounts(
      consistentlyWideSource,
      consistentlyWideDestination,
      VIDEO_CAPTURE_FRAME_RATE,
      outputSize,
    ))
  })

  it('ease-in-out interpolates pan and rotation while preserving source zoom', () => {
    const source = makeView('first', 0, 1_000).viewpoint
    const destination = makeView('second', 100, 4_000).viewpoint
    const midpoint = interpolatePanViewpoint(source, destination, 0.5)

    expect(midpoint.scale).toBe(1_000)
    expect(midpoint.rotation).toBeCloseTo(0)
    expect(midpoint.targetGeometry).toMatchObject({ x: 50, y: 0 })
  })

  it('creates synchronized pan, zoom, and layer transition frames', () => {
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
    expect(transitionFrames.every((frame) => frame.phase === 'transition')).toBe(true)
    expect(transitionFrames.every((frame) => frame.panProgress !== undefined)).toBe(true)
    expect(transitionFrames.every((frame) => frame.zoomProgress !== undefined)).toBe(true)
    expect(transitionFrames.every((frame) => frame.layerProgress !== undefined)).toBe(true)
    expect(transitionFrames[0].transitionProgress).toBeGreaterThan(0)
    expect(transitionFrames.at(-1)?.transitionProgress).toBe(1)
  })

  it('keeps source layers during synchronized transitions until compositing', () => {
    const timeline = createVideoTimeline([
      makeView('first', 0, 1_000),
      makeView('second', 200, 2_000),
    ])

    const transitionFrames = timeline.frames.filter((frame) => frame.sceneId === undefined)
    expect(transitionFrames.length).toBeGreaterThan(1)
    expect(transitionFrames.every((frame) => frame.phase === 'transition')).toBe(true)
    expect(transitionFrames.every((frame) => frame.layers[0]?.visible)).toBe(true)
    expect(transitionFrames.every((frame) => frame.layerProgress !== undefined)).toBe(true)
    expect(timeline.frames.at(-1)?.sceneId).toBe('second')
  })

  it('includes the largest zoom timeline pass in temporary storage estimates', () => {
    const views = [
      makeView('first', 0, 8_000),
      makeView('second', 200, 1_000),
    ]
    const estimate = estimateVideoCapture(views)

    expect(estimate).toBeDefined()
    expect(estimate?.workingBytes).toBeGreaterThan(
      (estimate?.frameCount ?? 0) * views[0].thumbnailBlob.size,
    )
  })

  it('returns no estimate instead of throwing for incompatible draft layers', () => {
    const source = makeView('first', 0, 8_000)
    const destination = makeView('second', 200, 1_000)
    destination.layers = []

    expect(estimateVideoCapture([source, destination])).toBeUndefined()
  })

  it('uses a standalone one-second cross-fade for layer-only changes', () => {
    const source = makeView('first', 0, 1_000)
    const destination = makeView('second', 0, 1_000)
    destination.viewpoint.rotation = source.viewpoint.rotation

    expect(calculateTransitionFrameCounts(source, destination)).toEqual({
      layerCrossFade: videoTimingConstants.layerCrossFadeSeconds * VIDEO_CAPTURE_FRAME_RATE,
      pan: 0,
      transition: videoTimingConstants.layerCrossFadeSeconds * VIDEO_CAPTURE_FRAME_RATE,
      zoomAnimation: 0,
    })
    const transitionFrames = createVideoTimeline([source, destination]).frames.filter(
      (frame) => frame.sceneId === undefined,
    )
    expect(transitionFrames.every((frame) => frame.phase === 'transition')).toBe(true)
    expect(transitionFrames.every((frame) => frame.layerProgress !== undefined)).toBe(true)
    expect(transitionFrames.every((frame) => frame.panProgress === undefined)).toBe(true)
    expect(transitionFrames.every((frame) => frame.zoomProgress === undefined)).toBe(true)
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
