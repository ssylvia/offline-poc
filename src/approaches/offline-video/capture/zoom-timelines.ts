import type { JsonObject } from '../../../shared/arcgis/index.ts'
import type { CapturedLayerState, VideoDraftView } from '../types.ts'
import type { VideoTimelineFrame } from './timeline.ts'

const zoomTimelineFadePortion = 0.18

export interface ZoomDetailStep {
  endProgress: number
  fromScale: number
  startProgress: number
  toScale: number
}

export interface ZoomTimelineCapture {
  captureId: string
  layers: CapturedLayerState[]
  outputFrameIndex: number
  viewpoint: JsonObject
}

export interface ZoomTimeline {
  captures: ZoomTimelineCapture[]
  id: string
  scale: number
}

export interface ZoomTimelineContribution {
  captureId: string
  imageScale: number
  opacity: number
  timelineId: string
}

export interface ZoomTimelineOutputFrame {
  contributions: ZoomTimelineContribution[]
  index: number
}

export interface ZoomTimelinePlan {
  outputFrames: ZoomTimelineOutputFrame[]
  timelines: ZoomTimeline[]
}

function readScale(viewpoint: JsonObject): number {
  const scale = viewpoint.scale
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) {
    throw new Error('A captured viewpoint has an invalid scale.')
  }
  return scale
}

function validateProgress(progress: number, message: string): void {
  if (!Number.isFinite(progress) || progress < 0 || progress > 1) {
    throw new Error(message)
  }
}

function validateLayerOpacity(layer: CapturedLayerState): void {
  if (!Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1) {
    throw new Error(`Captured layer “${layer.title}” has an invalid opacity.`)
  }
}

export function interpolateLayerStates(
  source: CapturedLayerState[],
  destination: CapturedLayerState[],
  progress: number,
): CapturedLayerState[] {
  validateProgress(progress, 'Layer transition progress must be between zero and one.')
  if (source.length !== destination.length) {
    throw new Error('Captured layer states changed after the video views were saved.')
  }
  const destinationById = new Map(destination.map((layer) => [layer.id, layer]))
  const sourceIds = new Set(source.map((layer) => layer.id))
  if (destination.some((layer) => !sourceIds.has(layer.id))) {
    throw new Error('Captured layer states changed after the video views were saved.')
  }

  return source.map((sourceLayer) => {
    const destinationLayer = destinationById.get(sourceLayer.id)
    if (!destinationLayer) {
      throw new Error('Captured layer states changed after the video views were saved.')
    }
    validateLayerOpacity(sourceLayer)
    validateLayerOpacity(destinationLayer)
    const sourceOpacity = sourceLayer.visible ? sourceLayer.opacity : 0
    const destinationOpacity = destinationLayer.visible ? destinationLayer.opacity : 0
    return {
      ...destinationLayer,
      opacity: sourceOpacity + (destinationOpacity - sourceOpacity) * progress,
      visible: sourceLayer.visible || destinationLayer.visible,
    }
  })
}

export function planZoomDetailSteps(
  sourceScale: number,
  destinationScale: number,
): ZoomDetailStep[] {
  if (
    !Number.isFinite(sourceScale)
    || sourceScale <= 0
    || !Number.isFinite(destinationScale)
    || destinationScale <= 0
    || sourceScale === destinationScale
  ) {
    throw new Error('Zoom animation requires two different positive map scales.')
  }
  const zoomStops = Math.abs(Math.log2(destinationScale / sourceScale))
  const stepCount = Math.max(1, Math.ceil(zoomStops))
  return Array.from({ length: stepCount }, (_, index) => {
    const startProgress = index / stepCount
    const endProgress = (index + 1) / stepCount
    return {
      endProgress,
      fromScale: sourceScale * Math.pow(destinationScale / sourceScale, startProgress),
      startProgress,
      toScale: sourceScale * Math.pow(destinationScale / sourceScale, endProgress),
    }
  })
}

function getActiveZoomDetailStepIndex(
  steps: ZoomDetailStep[],
  progress: number,
): number {
  validateProgress(progress, 'Zoom detail progress must be between zero and one.')
  const index = steps.findIndex((step) => progress <= step.endProgress)
  return index < 0 ? steps.length - 1 : index
}

function cloneLayers(layers: CapturedLayerState[]): CapturedLayerState[] {
  return layers.map((layer) => ({ ...layer }))
}

export function createZoomTimelinePlan(
  frames: VideoTimelineFrame[],
  source: Pick<VideoDraftView, 'layers' | 'viewpoint'>,
  destination: Pick<VideoDraftView, 'layers' | 'viewpoint'>,
): ZoomTimelinePlan {
  const sourceScale = readScale(source.viewpoint)
  const destinationScale = readScale(destination.viewpoint)
  const steps = sourceScale === destinationScale
    ? []
    : planZoomDetailSteps(sourceScale, destinationScale)
  const timelineScales = steps.length === 0
    ? [sourceScale]
    : [sourceScale, ...steps.map((step) => step.toScale)]
  const timelines: ZoomTimeline[] = timelineScales.map((scale, index) => ({
    captures: [],
    id: `zoom-${index}`,
    scale,
  }))
  const captureIds = new Set<string>()

  const addCapture = (
    timelineIndex: number,
    frame: VideoTimelineFrame,
    layers: CapturedLayerState[],
  ): ZoomTimelineContribution => {
    const timeline = timelines[timelineIndex]
    if (!timeline) {
      throw new Error('A zoom timeline is missing from the transition plan.')
    }
    const captureId = `${timeline.id}:frame-${frame.index}`
    if (!captureIds.has(captureId)) {
      timeline.captures.push({
        captureId,
        layers: cloneLayers(layers),
        outputFrameIndex: frame.index,
        viewpoint: {
          ...frame.viewpoint,
          scale: timeline.scale,
        },
      })
      captureIds.add(captureId)
    }
    return {
      captureId,
      imageScale: 1,
      opacity: 1,
      timelineId: timeline.id,
    }
  }

  const outputFrames = frames.map((frame): ZoomTimelineOutputFrame => {
    if (frame.phase !== 'transition') {
      throw new Error('Zoom timelines can only be created for transition frames.')
    }
    const layers = frame.layerProgress === undefined
      ? cloneLayers(source.layers)
      : interpolateLayerStates(source.layers, destination.layers, frame.layerProgress)
    if (steps.length === 0) {
      return {
        contributions: [addCapture(0, frame, layers)],
        index: frame.index,
      }
    }

    const progress = frame.zoomProgress
    if (progress === undefined) {
      throw new Error(`Transition frame ${frame.index + 1} is missing zoom progress.`)
    }
    const stepIndex = getActiveZoomDetailStepIndex(steps, progress)
    const step = steps[stepIndex]
    if (!step) {
      throw new Error('A zoom detail step is missing from the transition plan.')
    }
    const stepLength = step.endProgress - step.startProgress
    const stepProgress = Math.min(
      1,
      Math.max(0, (progress - step.startProgress) / Math.max(Number.EPSILON, stepLength)),
    )
    const targetScale = step.fromScale
      * Math.pow(step.toScale / step.fromScale, stepProgress)
    const zoomingIn = destinationScale < sourceScale
    const contributions: ZoomTimelineContribution[] = []

    if (zoomingIn) {
      const fadeProgress = Math.min(
        1,
        Math.max(0, (stepProgress - (1 - zoomTimelineFadePortion)) / zoomTimelineFadePortion),
      )
      if (fadeProgress < 1) {
        const sourceContribution = addCapture(stepIndex, frame, layers)
        sourceContribution.imageScale = step.fromScale / targetScale
        contributions.push(sourceContribution)
      }
      if (fadeProgress > 0) {
        const destinationContribution = addCapture(stepIndex + 1, frame, layers)
        destinationContribution.opacity = fadeProgress
        contributions.push(destinationContribution)
      }
    } else {
      const fadeProgress = Math.min(
        1,
        Math.max(0, stepProgress / zoomTimelineFadePortion),
      )
      if (fadeProgress > 0) {
        const destinationContribution = addCapture(stepIndex + 1, frame, layers)
        destinationContribution.imageScale = step.toScale / targetScale
        contributions.push(destinationContribution)
      }
      if (fadeProgress < 1) {
        const sourceContribution = addCapture(stepIndex, frame, layers)
        sourceContribution.opacity = 1 - fadeProgress
        contributions.push(sourceContribution)
      }
    }

    if (contributions.length === 0) {
      throw new Error(`Transition frame ${frame.index + 1} has no zoom timeline image.`)
    }
    return { contributions, index: frame.index }
  })

  return { outputFrames, timelines }
}

export const zoomTimelineConstants = {
  fadePortion: zoomTimelineFadePortion,
}
