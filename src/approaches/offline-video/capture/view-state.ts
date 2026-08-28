import { whenOnce } from '@arcgis/core/core/reactiveUtils.js'
import type WebMap from '@arcgis/core/WebMap.js'
import type MapView from '@arcgis/core/views/MapView.js'
import type { CapturedLayerState, VideoOutputSize } from '../types.ts'

const maximumVideoOutputWidth = 1_920
const maximumVideoOutputHeight = 1_080
const maximumVideoOutputScale = 2
const zoomDetailStepFadePortion = 0.18

export interface ZoomDetailStep {
  endProgress: number
  fromScale: number
  startProgress: number
  toScale: number
}

function ensureEvenPixelSize(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2)
}

function validateZoomScales(sourceScale: number, destinationScale: number): void {
  if (
    !Number.isFinite(sourceScale)
    || sourceScale <= 0
    || !Number.isFinite(destinationScale)
    || destinationScale <= 0
    || sourceScale === destinationScale
  ) {
    throw new Error('Zoom animation requires two different positive map scales.')
  }
}

export function captureLayerStates(map: WebMap): CapturedLayerState[] {
  return map.allLayers.toArray().map((layer) => ({
    id: layer.id,
    opacity: layer.opacity,
    title: layer.title ?? layer.id,
    visible: layer.visible,
  }))
}

export function applyLayerStates(map: WebMap, states: CapturedLayerState[]): void {
  const layers = new Map(map.allLayers.toArray().map((layer) => [layer.id, layer]))
  const resolvedStates = states.map((state) => {
    const layer = layers.get(state.id)
    if (!layer) {
      throw new Error(`Captured layer “${state.title}” is no longer present in the WebMap.`)
    }
    return { layer, state }
  })

  for (const { layer, state } of resolvedStates) {
    layer.visible = state.visible
    layer.opacity = state.opacity
  }
}

export function getVideoOutputSize(view: MapView): VideoOutputSize {
  if (view.width < 1 || view.height < 1) {
    throw new Error('The map preview is too small to capture a video.')
  }
  const scale = Math.max(1, Math.min(
    maximumVideoOutputScale,
    maximumVideoOutputWidth / view.width,
    maximumVideoOutputHeight / view.height,
  ))
  const width = ensureEvenPixelSize(view.width * scale)
  const height = ensureEvenPixelSize(view.height * scale)
  if (width < 2 || height < 2) {
    throw new Error('The map preview is too small to capture a video.')
  }
  return { height, width }
}

export async function waitForViewStable(view: MapView, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  await whenOnce(() => !view.updating, { signal })
  signal?.throwIfAborted()
}

export async function takeMapOnlyScreenshot(
  view: MapView,
  size: VideoOutputSize,
  signal?: AbortSignal,
): Promise<Blob> {
  signal?.throwIfAborted()
  await waitForViewStable(view, signal)
  const popup = view.popup
  const popupWasVisible = popup?.visible ?? false
  if (popup) {
    popup.visible = false
  }

  try {
    const screenshot = await view.takeScreenshot({
      format: 'png',
      height: size.height,
      width: size.width,
    })
    signal?.throwIfAborted()
    const blob = dataUrlToBlob(screenshot.dataUrl)
    if (blob.size === 0) {
      throw new Error('The captured map frame was empty.')
    }
    return blob
  } finally {
    if (popup) {
      popup.visible = popupWasVisible
    }
  }
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const separatorIndex = dataUrl.indexOf(',')
  if (!dataUrl.startsWith('data:') || separatorIndex < 0) {
    throw new Error('The captured map frame was not a valid data URL.')
  }
  const metadata = dataUrl.slice(5, separatorIndex)
  const encoded = dataUrl.slice(separatorIndex + 1)
  const isBase64 = metadata.split(';').includes('base64')
  const mimeType = metadata.split(';')[0] || 'application/octet-stream'

  try {
    if (!isBase64) {
      return new Blob([decodeURIComponent(encoded)], { type: mimeType })
    }
    const binary = atob(encoded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return new Blob([bytes], { type: mimeType })
  } catch (error) {
    throw new Error('The captured map frame could not be decoded.', { cause: error })
  }
}

export async function crossFadeImageBlobs(
  source: Blob,
  destination: Blob,
  size: VideoOutputSize,
  progress: number,
  signal?: AbortSignal,
): Promise<Blob> {
  if (!Number.isFinite(progress) || progress < 0 || progress > 1) {
    throw new Error('Cross-fade progress must be between zero and one.')
  }
  signal?.throwIfAborted()
  if (progress === 0) {
    return source
  }
  if (progress === 1) {
    return destination
  }

  const [sourceBitmap, destinationBitmap] = await Promise.all([
    createImageBitmap(source),
    createImageBitmap(destination),
  ])
  try {
    signal?.throwIfAborted()
    const canvas = document.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) {
      throw new Error('The browser could not create a layer cross-fade canvas.')
    }
    context.globalAlpha = 1
    context.drawImage(sourceBitmap, 0, 0, size.width, size.height)
    context.globalAlpha = progress
    context.drawImage(destinationBitmap, 0, 0, size.width, size.height)
    signal?.throwIfAborted()
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob)
        } else {
          reject(new Error('The layer cross-fade frame could not be encoded.'))
        }
      }, 'image/png')
    })
  } finally {
    sourceBitmap.close()
    destinationBitmap.close()
  }
}

export async function createZoomImageFrame(
  source: Blob,
  destination: Blob,
  size: VideoOutputSize,
  progress: number,
  sourceScale: number,
  destinationScale: number,
  signal?: AbortSignal,
): Promise<Blob> {
  if (!Number.isFinite(progress) || progress < 0 || progress > 1) {
    throw new Error('Zoom animation progress must be between zero and one.')
  }
  validateZoomScales(sourceScale, destinationScale)
  signal?.throwIfAborted()
  if (progress === 0) {
    return source
  }
  if (progress === 1) {
    return destination
  }

  const zoomingIn = destinationScale < sourceScale
  const maximumImageScale = zoomingIn
    ? sourceScale / destinationScale
    : destinationScale / sourceScale
  const imageScale = zoomingIn
    ? Math.pow(maximumImageScale, progress)
    : Math.pow(maximumImageScale, 1 - progress)
  const image = await createImageBitmap(zoomingIn ? source : destination)
  try {
    signal?.throwIfAborted()
    const canvas = document.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) {
      throw new Error('The browser could not create a zoom animation canvas.')
    }
    const width = size.width * imageScale
    const height = size.height * imageScale
    context.drawImage(
      image,
      (size.width - width) / 2,
      (size.height - height) / 2,
      width,
      height,
    )
    signal?.throwIfAborted()
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob)
        } else {
          reject(new Error('The zoom animation frame could not be encoded.'))
        }
      }, 'image/png')
    })
  } finally {
    image.close()
  }
}

export function planZoomDetailSteps(
  sourceScale: number,
  destinationScale: number,
): ZoomDetailStep[] {
  validateZoomScales(sourceScale, destinationScale)
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

export function getActiveZoomDetailStep(
  steps: ZoomDetailStep[],
  progress: number,
): ZoomDetailStep | undefined {
  if (!Number.isFinite(progress) || progress < 0 || progress > 1) {
    throw new Error('Zoom detail progress must be between zero and one.')
  }
  return steps.find((step) => progress <= step.endProgress) ?? steps.at(-1)
}

export async function createTransitionImageFrame(
  source: Blob,
  destination: Blob,
  size: VideoOutputSize,
  progress: number,
  sourceScale?: number,
  destinationScale?: number,
  layerProgress?: number,
  signal?: AbortSignal,
): Promise<Blob> {
  if (!Number.isFinite(progress) || progress < 0 || progress > 1) {
    throw new Error('Transition progress must be between zero and one.')
  }
  let frame = source
  if (sourceScale !== undefined && destinationScale !== undefined && sourceScale !== destinationScale) {
    const steps = planZoomDetailSteps(sourceScale, destinationScale)
    const activeStep = getActiveZoomDetailStep(steps, progress)
    if (activeStep) {
      const stepProgress = (progress - activeStep.startProgress)
        / Math.max(Number.EPSILON, activeStep.endProgress - activeStep.startProgress)
      frame = await createZoomImageFrame(
        source,
        destination,
        size,
        Math.min(1, Math.max(0, stepProgress)),
        activeStep.fromScale,
        activeStep.toScale,
        signal,
      )
      const fadeStart = activeStep.endProgress
        - (activeStep.endProgress - activeStep.startProgress) * zoomDetailStepFadePortion
      if (progress >= fadeStart) {
        const fadeProgress = (progress - fadeStart) / Math.max(Number.EPSILON, activeStep.endProgress - fadeStart)
        frame = await crossFadeImageBlobs(
          frame,
          destination,
          size,
          Math.min(1, Math.max(0, fadeProgress)),
          signal,
        )
      }
    }
  }
  if (layerProgress !== undefined) {
    frame = await crossFadeImageBlobs(frame, destination, size, layerProgress, signal)
  }
  return frame
}
