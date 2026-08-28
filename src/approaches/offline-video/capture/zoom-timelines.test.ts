import { describe, expect, it } from 'vitest'
import type { VideoDraftView } from '../types.ts'
import type { VideoTimelineFrame } from './timeline.ts'
import {
  createZoomTimelinePlan,
  getZoomTimelineCaptureSize,
  interpolateLayerStates,
  planZoomDetailSteps,
  zoomTimelineConstants,
} from './zoom-timelines.ts'

function createView(
  id: string,
  scale: number,
  roadsVisible: boolean,
): VideoDraftView {
  return {
    capturedAt: 1,
    extent: { xmin: 0, ymin: 0, xmax: 100, ymax: 100 },
    id,
    layers: [
      {
        id: 'roads',
        opacity: 1,
        title: 'Roads',
        visible: roadsVisible,
      },
      {
        id: 'labels',
        opacity: 0.5,
        title: 'Labels',
        visible: !roadsVisible,
      },
    ],
    name: id,
    thumbnailBlob: new Blob(['thumbnail']),
    viewpoint: {
      rotation: 0,
      scale,
      targetGeometry: { x: roadsVisible ? 0 : 100, y: 0 },
    },
  }
}

function createFrame(index: number, progress: number): VideoTimelineFrame {
  return {
    destinationScale: 1_000,
    index,
    layerProgress: progress,
    layers: [],
    panProgress: progress,
    phase: 'transition',
    sourceScale: 8_000,
    timeMs: index * 40,
    transitionFromSceneId: 'source',
    transitionProgress: progress,
    transitionToSceneId: 'destination',
    viewpoint: {
      rotation: progress * 20,
      scale: 8_000,
      targetGeometry: { x: progress * 100, y: 0 },
    },
    zoomProgress: progress,
  }
}

describe('zoom-level video timelines', () => {
  it('plans one bounded animation timeline for every zoom detail level', () => {
    expect(planZoomDetailSteps(8_000, 1_000)).toEqual([
      { endProgress: 1 / 3, fromScale: 8_000, startProgress: 0, toScale: 4_000 },
      { endProgress: 2 / 3, fromScale: 4_000, startProgress: 1 / 3, toScale: 2_000 },
      { endProgress: 1, fromScale: 2_000, startProgress: 2 / 3, toScale: 1_000 },
    ])
    expect(getZoomTimelineCaptureSize({ height: 1_080, width: 1_920 })).toEqual({
      height: 1_296,
      width: 2_304,
    })
  })

  it('groups captures by zoom level and never reuses endpoint images for middle levels', () => {
    const frames = [
      createFrame(0, 0.1),
      createFrame(1, 0.32),
      createFrame(2, 0.5),
      createFrame(3, 0.65),
      createFrame(4, 0.85),
      createFrame(5, 1),
    ]
    const plan = createZoomTimelinePlan(
      frames,
      createView('source', 8_000, true),
      createView('destination', 1_000, false),
    )

    expect(plan.timelines.map((timeline) => timeline.scale)).toEqual([
      8_000,
      4_000,
      2_000,
      1_000,
    ])
    for (const timeline of plan.timelines) {
      expect(timeline.captures.map((capture) => capture.outputFrameIndex)).toEqual(
        [...timeline.captures]
          .sort((left, right) => left.outputFrameIndex - right.outputFrameIndex)
          .map((capture) => capture.outputFrameIndex),
      )
      expect(timeline.captures.every(
        (capture) => capture.viewpoint.scale === timeline.scale,
      )).toBe(true)
    }

    const middleFrame = plan.outputFrames.find((frame) => frame.index === 2)
    expect(middleFrame?.contributions.map((entry) => entry.timelineId)).toEqual(['zoom-1'])
    expect(middleFrame?.contributions.some(
      (entry) => entry.timelineId === 'zoom-0' || entry.timelineId === 'zoom-3',
    )).toBe(false)
  })

  it('captures pan and ArcGIS opacity changes in phase on both sides of a detail cross-fade', () => {
    const source = createView('source', 8_000, true)
    const destination = createView('destination', 1_000, false)
    const frame = createFrame(7, 0.32)
    const plan = createZoomTimelinePlan([frame], source, destination)
    const output = plan.outputFrames[0]

    expect(output?.contributions).toHaveLength(2)
    const contributionRatios = output?.contributions.map((contribution) => {
      const timeline = plan.timelines.find((entry) => entry.id === contribution.timelineId)
      return contribution.imageScale / (timeline?.scale ?? 1)
    })
    expect(contributionRatios?.[0]).toBeCloseTo(contributionRatios?.[1] ?? 0)
    const captures = output?.contributions.map((contribution) => {
      const timeline = plan.timelines.find((entry) => entry.id === contribution.timelineId)
      return timeline?.captures.find((capture) => capture.captureId === contribution.captureId)
    })
    expect(captures?.every((capture) => {
      const target = capture?.viewpoint.targetGeometry
      return Boolean(
        target
        && typeof target === 'object'
        && !Array.isArray(target)
        && target.x === 32,
      )
    })).toBe(true)
    expect(captures?.map((capture) => capture?.layers)).toEqual([
      interpolateLayerStates(source.layers, destination.layers, 0.32),
      interpolateLayerStates(source.layers, destination.layers, 0.32),
    ])
    expect(captures?.[0]?.layers[0]).toMatchObject({ id: 'roads', visible: true })
    expect(captures?.[0]?.layers[0]?.opacity).toBeCloseTo(0.68)
    expect(captures?.[0]?.layers[1]).toMatchObject({ id: 'labels', visible: true })
    expect(captures?.[0]?.layers[1]?.opacity).toBeCloseTo(0.16)
  })

  it('uses the wider destination buffer while contracting a zoom-out timeline', () => {
    const source = createView('source', 1_000, true)
    const destination = createView('destination', 2_000, false)
    const frame = {
      ...createFrame(0, 0.5),
      destinationScale: 2_000,
      sourceScale: 1_000,
    }
    const output = createZoomTimelinePlan([frame], source, destination).outputFrames[0]

    expect(output?.contributions).toHaveLength(1)
    expect(output?.contributions[0]?.timelineId).toBe('zoom-1')
    expect(output?.contributions[0]?.imageScale).toBeCloseTo(
      zoomTimelineConstants.overscan * Math.SQRT2,
    )
  })
})
