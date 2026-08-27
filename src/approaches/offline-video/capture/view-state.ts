import { whenOnce } from '@arcgis/core/core/reactiveUtils.js'
import type WebMap from '@arcgis/core/WebMap.js'
import type MapView from '@arcgis/core/views/MapView.js'
import type { CapturedLayerState, VideoOutputSize } from '../types.ts'

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
  const width = Math.floor(view.width / 2) * 2
  const height = Math.floor(view.height / 2) * 2
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
