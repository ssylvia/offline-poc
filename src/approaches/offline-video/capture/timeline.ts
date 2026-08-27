import type { JsonObject } from '../../../shared/arcgis/index.ts'
import {
  VIDEO_CAPTURE_FRAME_RATE,
  VIDEO_FINAL_VIEW_HOLD_MS,
  type CapturedLayerState,
  type VideoDraftView,
  type VideoTimelineScene,
} from '../types.ts'

const minimumTransitionMs = 1_500
const maximumTransitionMs = 8_000
const nominalViewportWidthPixels = 960
const metersPerPixelAtScaleOne = 0.0002645833333333333

interface PointLike {
  x: number
  y: number
}

interface ExtentLike {
  xmax: number
  xmin: number
  ymax: number
  ymin: number
}

export interface VideoTimelineFrame {
  index: number
  layers: CapturedLayerState[]
  sceneId?: string
  timeMs: number
  viewpoint: JsonObject
}

export interface VideoTimelinePlan {
  durationMs: number
  frames: VideoTimelineFrame[]
  scenes: VideoTimelineScene[]
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readPoint(viewpoint: JsonObject): PointLike {
  const target = viewpoint.targetGeometry
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new Error('A captured viewpoint is missing its target geometry.')
  }
  const x = finiteNumber(target.x)
  const y = finiteNumber(target.y)
  if (x === undefined || y === undefined) {
    throw new Error('A captured viewpoint has an invalid center point.')
  }
  return { x, y }
}

function readExtent(extent: JsonObject): ExtentLike {
  const xmin = finiteNumber(extent.xmin)
  const ymin = finiteNumber(extent.ymin)
  const xmax = finiteNumber(extent.xmax)
  const ymax = finiteNumber(extent.ymax)
  if (
    xmin === undefined
    || ymin === undefined
    || xmax === undefined
    || ymax === undefined
    || xmax <= xmin
    || ymax <= ymin
  ) {
    throw new Error('A captured view has an invalid extent.')
  }
  return { xmin, ymin, xmax, ymax }
}

function readScale(viewpoint: JsonObject): number {
  const scale = finiteNumber(viewpoint.scale)
  if (scale === undefined || scale <= 0) {
    throw new Error('A captured viewpoint has an invalid scale.')
  }
  return scale
}

function interpolateRotation(source: number, destination: number, progress: number): number {
  const delta = ((destination - source + 540) % 360) - 180
  return (source + delta * progress + 360) % 360
}

export function calculateTransitionDurationMs(
  source: Pick<VideoDraftView, 'extent' | 'viewpoint'>,
  destination: Pick<VideoDraftView, 'extent' | 'viewpoint'>,
): number {
  const sourceCenter = readPoint(source.viewpoint)
  const destinationCenter = readPoint(destination.viewpoint)
  const sourceExtent = readExtent(source.extent)
  const destinationExtent = readExtent(destination.extent)
  const averageViewportWidth = (
    sourceExtent.xmax - sourceExtent.xmin + destinationExtent.xmax - destinationExtent.xmin
  ) / 2
  const panInViewportWidths = Math.hypot(
    destinationCenter.x - sourceCenter.x,
    destinationCenter.y - sourceCenter.y,
  ) / averageViewportWidth
  const zoomStops = Math.abs(Math.log2(
    readScale(destination.viewpoint) / readScale(source.viewpoint),
  ))
  const duration = 1_200 + panInViewportWidths * 900 + zoomStops * 650
  return Math.min(maximumTransitionMs, Math.max(minimumTransitionMs, Math.round(duration)))
}

export function interpolateViewpoint(
  source: JsonObject,
  destination: JsonObject,
  progress: number,
): JsonObject {
  if (!Number.isFinite(progress) || progress < 0 || progress > 1) {
    throw new Error('Viewpoint interpolation progress must be between zero and one.')
  }

  const sourcePoint = readPoint(source)
  const destinationPoint = readPoint(destination)
  const sourceScale = readScale(source)
  const destinationScale = readScale(destination)
  const sourceRotation = finiteNumber(source.rotation) ?? 0
  const destinationRotation = finiteNumber(destination.rotation) ?? 0
  const targetGeometry = destination.targetGeometry
  if (!targetGeometry || typeof targetGeometry !== 'object' || Array.isArray(targetGeometry)) {
    throw new Error('A captured viewpoint is missing its target geometry.')
  }

  return {
    ...destination,
    rotation: interpolateRotation(sourceRotation, destinationRotation, progress),
    scale: sourceScale * Math.pow(destinationScale / sourceScale, progress),
    targetGeometry: {
      ...targetGeometry,
      x: sourcePoint.x + (destinationPoint.x - sourcePoint.x) * progress,
      y: sourcePoint.y + (destinationPoint.y - sourcePoint.y) * progress,
    },
  }
}

function cloneLayers(layers: CapturedLayerState[]): CapturedLayerState[] {
  return layers.map((layer) => ({ ...layer }))
}

function calculateSceneTimestampMs(
  holdStartMs: number,
  holdEndMs: number,
  holdFrameCount: number,
  frameDurationMs: number,
): number {
  const midpointFrame = Math.floor((holdFrameCount - 1) / 2)
  const timestampMs = holdStartMs + (midpointFrame + 0.5) * frameDurationMs
  return Math.min(timestampMs, holdEndMs - frameDurationMs * 0.5)
}

export function createVideoTimeline(
  views: VideoDraftView[],
  frameRate = VIDEO_CAPTURE_FRAME_RATE,
  holdMs = VIDEO_FINAL_VIEW_HOLD_MS,
): VideoTimelinePlan {
  if (views.length === 0) {
    throw new Error('Add at least one final view before creating a video.')
  }
  if (!Number.isFinite(frameRate) || frameRate <= 0) {
    throw new Error('Video frame rate must be greater than zero.')
  }
  if (!Number.isFinite(holdMs) || holdMs <= 0) {
    throw new Error('Final-view hold duration must be greater than zero.')
  }

  const frameDurationMs = 1_000 / frameRate
  const holdFrameCount = Math.max(1, Math.ceil(holdMs / frameDurationMs))
  const frames: VideoTimelineFrame[] = []
  const scenes: VideoTimelineScene[] = []
  let elapsedMs = 0

  for (const [viewIndex, view] of views.entries()) {
    const previousView = views[viewIndex - 1]
    const transitionStartMs = elapsedMs

    if (previousView) {
      const transitionMs = calculateTransitionDurationMs(previousView, view)
      const transitionFrameCount = Math.max(1, Math.ceil(transitionMs / frameDurationMs))
      for (let index = 0; index < transitionFrameCount; index += 1) {
        const progress = (index + 1) / transitionFrameCount
        frames.push({
          index: frames.length,
          layers: cloneLayers(progress < 0.5 ? previousView.layers : view.layers),
          timeMs: elapsedMs,
          viewpoint: interpolateViewpoint(previousView.viewpoint, view.viewpoint, progress),
        })
        elapsedMs += frameDurationMs
      }
    }

    const holdStartMs = elapsedMs
    for (let index = 0; index < holdFrameCount; index += 1) {
      frames.push({
        index: frames.length,
        layers: cloneLayers(view.layers),
        sceneId: view.id,
        timeMs: elapsedMs,
        viewpoint: view.viewpoint,
      })
      elapsedMs += frameDurationMs
    }
    const holdEndMs = elapsedMs
    scenes.push({
      holdEndMs,
      holdStartMs,
      id: view.id,
      index: viewIndex,
      layers: cloneLayers(view.layers),
      name: view.name,
      popup: view.popup,
      timestampMs: calculateSceneTimestampMs(
        holdStartMs,
        holdEndMs,
        holdFrameCount,
        frameDurationMs,
      ),
      transitionStartMs,
      viewpoint: view.viewpoint,
    })
  }

  return {
    durationMs: elapsedMs,
    frames,
    scenes,
  }
}

export function estimateVideoCapture(
  views: VideoDraftView[],
  frameRate = VIDEO_CAPTURE_FRAME_RATE,
): { durationMs: number; frameCount: number; workingBytes: number } | undefined {
  if (views.length === 0) {
    return undefined
  }
  const timeline = createVideoTimeline(views, frameRate)
  const firstThumbnail = views[0].thumbnailBlob.size
  return {
    durationMs: timeline.durationMs,
    frameCount: timeline.frames.length,
    workingBytes: timeline.frames.length * firstThumbnail,
  }
}

export const videoTimingConstants = {
  maximumTransitionMs,
  minimumTransitionMs,
  nominalViewportWidthPixels,
  metersPerPixelAtScaleOne,
}
