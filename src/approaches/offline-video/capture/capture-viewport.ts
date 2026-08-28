import Viewpoint from '@arcgis/core/Viewpoint.js'
import { whenOnce } from '@arcgis/core/core/reactiveUtils.js'
import type WebMap from '@arcgis/core/WebMap.js'
import MapView from '@arcgis/core/views/MapView.js'
import type { JsonObject } from '../../../shared/arcgis/index.ts'
import type { VideoOutputSize } from '../types.ts'

export interface VideoCaptureViewport {
  destroy: () => void
  view: MapView
}

function waitForViewReady(view: MapView, signal: AbortSignal): Promise<MapView> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const handleAbort = () => {
      signal.removeEventListener('abort', handleAbort)
      reject(signal.reason)
    }
    signal.addEventListener('abort', handleAbort, { once: true })
    void view.when().then(
      (readyView) => {
        signal.removeEventListener('abort', handleAbort)
        resolve(readyView)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', handleAbort)
        reject(error)
      },
    )
  })
}

export async function createVideoCaptureViewport(
  map: WebMap,
  viewpoint: JsonObject,
  size: VideoOutputSize,
  signal: AbortSignal,
): Promise<VideoCaptureViewport> {
  signal.throwIfAborted()
  const container = document.createElement('div')
  container.setAttribute('aria-hidden', 'true')
  container.inert = true
  Object.assign(container.style, {
    height: `${size.height}px`,
    left: '-10000px',
    pointerEvents: 'none',
    position: 'fixed',
    top: '0',
    visibility: 'hidden',
    width: `${size.width}px`,
  })
  document.body.append(container)

  let view: MapView | undefined
  const destroy = () => {
    if (view) {
      view.map = null
      view.destroy()
    }
    container.remove()
  }

  try {
    view = new MapView({
      container,
      map,
      padding: { bottom: 0, left: 0, right: 0, top: 0 },
      ui: { components: [] },
      viewpoint: Viewpoint.fromJSON(viewpoint),
    })
    const captureView = view
    await waitForViewReady(captureView, signal)
    await whenOnce(() => (
      captureView.width === size.width
      && captureView.height === size.height
      && !captureView.resizing
      && !captureView.updating
    ), { signal })
    signal.throwIfAborted()
    return { destroy, view: captureView }
  } catch (error) {
    destroy()
    throw error
  }
}
