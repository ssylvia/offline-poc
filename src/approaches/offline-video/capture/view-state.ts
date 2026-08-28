import { whenOnce } from '@arcgis/core/core/reactiveUtils.js'
import type WebMap from '@arcgis/core/WebMap.js'
import type MapView from '@arcgis/core/views/MapView.js'
import type { CapturedLayerState, VideoOutputSize } from '../types.ts'

export interface ZoomTimelineImage {
  blob: Blob
  imageScale: number
  opacity: number
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

export async function composeZoomTimelineFrame(
  images: ZoomTimelineImage[],
  size: VideoOutputSize,
  signal?: AbortSignal,
): Promise<Blob> {
  if (images.length === 0) {
    throw new Error('At least one zoom timeline image is required.')
  }
  for (const image of images) {
    if (!Number.isFinite(image.imageScale) || image.imageScale <= 0) {
      throw new Error('Zoom timeline image scale must be greater than zero.')
    }
    if (!Number.isFinite(image.opacity) || image.opacity < 0 || image.opacity > 1) {
      throw new Error('Zoom timeline image opacity must be between zero and one.')
    }
  }
  signal?.throwIfAborted()
  if (
    images.length === 1
    && images[0]?.imageScale === 1
    && images[0].opacity === 1
  ) {
    return images[0].blob
  }

  const bitmaps = await Promise.all(images.map((image) => createImageBitmap(image.blob)))
  try {
    signal?.throwIfAborted()
    const canvas = document.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) {
      throw new Error('The browser could not create a zoom timeline canvas.')
    }
    images.forEach((image, index) => {
      const bitmap = bitmaps[index]
      if (!bitmap) {
        throw new Error('A zoom timeline image could not be decoded.')
      }
      const width = size.width * image.imageScale
      const height = size.height * image.imageScale
      context.globalAlpha = image.opacity
      context.drawImage(
        bitmap,
        (size.width - width) / 2,
        (size.height - height) / 2,
        width,
        height,
      )
    })
    signal?.throwIfAborted()
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob)
        } else {
          reject(new Error('The zoom timeline frame could not be encoded.'))
        }
      }, 'image/png')
    })
  } finally {
    for (const bitmap of bitmaps) {
      bitmap.close()
    }
  }
}
