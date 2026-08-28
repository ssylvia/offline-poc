import Viewpoint from '@arcgis/core/Viewpoint.js'
import Point from '@arcgis/core/geometry/Point.js'
import type { LiveMapSession } from '../../../shared/arcgis/index.ts'
import { serializeArcGisJson } from '../../../shared/arcgis/index.ts'
import { createDirectoryStorageReference } from '../../../shared/storage/directory.ts'
import {
  deleteFrame,
  deletePackage,
  finalizePackage,
  getFrame,
  getFrameById,
  putAsset,
  putFrame,
  putPackage,
} from '../storage/database.ts'
import {
  VIDEO_CAPTURE_FRAME_RATE,
  VIDEO_FINAL_VIEW_HOLD_MS,
  VIDEO_PACKAGE_SCHEMA_VERSION,
  type SavedVideoPackage,
  type PopupAnchor,
  type VideoCaptureOptions,
  type VideoCaptureWarning,
  type VideoDraftView,
  type VideoOutputSize,
  type VideoPackageAsset,
  type VideoTimelineScene,
} from '../types.ts'
import { createVideoCaptureViewport } from './capture-viewport.ts'
import {
  createVideoTimeline,
  estimateVideoCapture,
} from './timeline.ts'
import { encodeVideoFrames } from './video-encoder.ts'
import { validateVideoOutputSize } from './video-settings.ts'
import {
  applyLayerStates,
  captureLayerStates,
  composeZoomTimelineFrame,
  takeMapOnlyScreenshot,
} from './view-state.ts'
import {
  createZoomTimelinePlan,
  getZoomTimelineCaptureSize,
} from './zoom-timelines.ts'

const largeWorkingCaptureBytes = 250 * 1024 * 1024
const videoReadbackErrorMessage = 'The encoded video could not be read back for verification.'
const timestampVerificationToleranceMs = 1

interface CaptureOfflineVideoInput {
  assets: VideoPackageAsset[]
  options: VideoCaptureOptions
  packageId: string
  session: LiveMapSession
  views: VideoDraftView[]
  warnings?: VideoCaptureWarning[]
}

interface OriginalMapState {
  layers: ReturnType<typeof captureLayerStates>
  popup: LiveMapSession['view']['popup']
  popupWasVisible: boolean
  viewpoint: ReturnType<typeof serializeArcGisJson>
}

interface CapturedTimelineFrames {
  popupAnchors: Map<string, PopupAnchor>
  thumbnailBlob: Blob
}

function asError(error: unknown, fallbackMessage: string): Error {
  return error instanceof Error ? error : new Error(fallbackMessage)
}

function createAggregateError(message: string, errors: Error[]): Error {
  return errors.length === 1 ? errors[0] : new AggregateError(errors, message)
}

function createCleanupError(context: string, error: unknown): Error {
  return new Error(`${context}: ${asError(error, context).message}`)
}

function waitForVideoEvent(
  video: HTMLVideoElement,
  eventName: 'loadeddata' | 'loadedmetadata' | 'seeked',
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener('abort', handleAbort)
      video.removeEventListener(eventName, handleSuccess)
      video.removeEventListener('error', handleError)
    }
    const handleAbort = () => {
      cleanup()
      reject(signal.reason)
    }
    const handleSuccess = () => {
      cleanup()
      resolve()
    }
    const handleError = () => {
      cleanup()
      const mediaError = video.error
      const detail = mediaError
        ? ` Media error ${mediaError.code}${mediaError.message ? `: ${mediaError.message}` : '.'}`
        : ''
      reject(new Error(`${videoReadbackErrorMessage}${detail}`))
    }

    signal.addEventListener('abort', handleAbort, { once: true })
    video.addEventListener(eventName, handleSuccess, { once: true })
    video.addEventListener('error', handleError, { once: true })
  })
}

async function readMeasuredDurationMs(
  video: HTMLVideoElement,
  signal: AbortSignal,
): Promise<number> {
  if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
    await waitForVideoEvent(video, 'loadedmetadata', signal)
  }
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    await waitForVideoEvent(video, 'loadeddata', signal)
  }
  const durationMs = video.duration * 1_000
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error('The encoded WebM video reported an invalid duration.')
  }
  return durationMs
}

function chooseVerifiedTimestampMs(
  holdStartMs: number,
  holdEndMs: number,
  preferredTimestampMs: number,
): number {
  if (!(holdEndMs > holdStartMs)) {
    throw new Error('A verified video scene has an invalid hold interval.')
  }
  if (preferredTimestampMs > holdStartMs && preferredTimestampMs < holdEndMs) {
    return preferredTimestampMs
  }
  return holdStartMs + (holdEndMs - holdStartMs) / 2
}

function measureVideoScenes(
  scenes: VideoTimelineScene[],
  plannedDurationMs: number,
  measuredDurationMs: number,
): VideoTimelineScene[] {
  if (!(plannedDurationMs > 0)) {
    throw new Error('The video timeline reported an invalid duration.')
  }
  const timeScale = measuredDurationMs / plannedDurationMs

  return scenes.map((scene) => {
    const holdStartMs = scene.holdStartMs * timeScale
    const holdEndMs = scene.holdEndMs * timeScale
    return {
      ...scene,
      holdEndMs,
      holdStartMs,
      timestampMs: chooseVerifiedTimestampMs(
        holdStartMs,
        holdEndMs,
        scene.timestampMs * timeScale,
      ),
      transitionStartMs: scene.transitionStartMs * timeScale,
    }
  })
}

async function seekVideoToTimestampMs(
  video: HTMLVideoElement,
  timestampMs: number,
  signal: AbortSignal,
): Promise<number> {
  const seeked = waitForVideoEvent(video, 'seeked', signal)
  video.currentTime = timestampMs / 1_000
  await seeked
  return video.currentTime * 1_000
}

async function verifyVideoBlob(
  blob: Blob,
  scenes: VideoTimelineScene[],
  plannedDurationMs: number,
  signal: AbortSignal,
): Promise<{ durationMs: number; scenes: VideoTimelineScene[] }> {
  signal.throwIfAborted()
  const url = URL.createObjectURL(blob)
  const video = document.createElement('video')
  video.preload = 'auto'

  try {
    video.src = url
    video.load()

    const durationMs = await readMeasuredDurationMs(video, signal)
    const verifiedScenes = measureVideoScenes(scenes, plannedDurationMs, durationMs)

    for (const [sceneIndex, scene] of verifiedScenes.entries()) {
      if (scene.timestampMs <= scene.holdStartMs || scene.timestampMs >= scene.holdEndMs) {
        throw new Error(`Verified scene ${sceneIndex + 1} timestamp falls outside its final hold.`)
      }
      if (scene.holdEndMs > durationMs + timestampVerificationToleranceMs) {
        throw new Error(`Verified scene ${sceneIndex + 1} extends past the encoded WebM duration.`)
      }
      if (
        sceneIndex > 0
        && scene.timestampMs <= verifiedScenes[sceneIndex - 1].timestampMs
      ) {
        throw new Error('Verified scene timestamps must remain strictly increasing.')
      }

      const actualTimestampMs = await seekVideoToTimestampMs(video, scene.timestampMs, signal)
      if (
        actualTimestampMs <= scene.holdStartMs + timestampVerificationToleranceMs
        || actualTimestampMs >= scene.holdEndMs - timestampVerificationToleranceMs
      ) {
        throw new Error(`Verified scene ${sceneIndex + 1} could not seek inside its final hold.`)
      }
    }

    return { durationMs, scenes: verifiedScenes }
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}

function captureOriginalMapState(session: LiveMapSession): OriginalMapState {
  return {
    layers: captureLayerStates(session.map),
    popup: session.view.popup,
    popupWasVisible: session.view.popup?.visible ?? false,
    viewpoint: serializeArcGisJson(session.view.viewpoint),
  }
}

async function restoreOriginalMapState(
  session: LiveMapSession,
  originalState: OriginalMapState,
): Promise<void> {
  const restorationErrors: Error[] = []

  try {
    applyLayerStates(session.map, originalState.layers)
  } catch (error) {
    restorationErrors.push(createCleanupError('Could not restore the original layer state', error))
  }

  try {
    await session.view.goTo(Viewpoint.fromJSON(originalState.viewpoint), { animate: false })
  } catch (error) {
    restorationErrors.push(createCleanupError('Could not restore the original map viewpoint', error))
  }

  if (originalState.popup) {
    try {
      originalState.popup.visible = originalState.popupWasVisible
    } catch (error) {
      restorationErrors.push(createCleanupError('Could not restore the original popup visibility', error))
    }
  }

  if (restorationErrors.length > 0) {
    throw createAggregateError(
      'Offline video capture could not restore the live map state.',
      restorationErrors,
    )
  }
}

async function captureTimelineFrames(options: {
  originalState: OriginalMapState
  packageId: string
  progress: VideoCaptureOptions['onProgress']
  session: LiveMapSession
  signal: AbortSignal
  size: VideoOutputSize
  storage?: Extract<SavedVideoPackage['payloadStorage'], { kind: 'directory' }>
  timeline: ReturnType<typeof createVideoTimeline>
  views: VideoDraftView[]
}): Promise<CapturedTimelineFrames> {
  const {
    originalState,
    packageId,
    progress,
    session,
    signal,
    size,
    storage,
    timeline,
    views,
  } = options

  const transitions = views.slice(1).map((destination, index) => {
    const source = views[index]
    if (!source) {
      throw new Error('A video transition is missing its source view.')
    }
    const frames = timeline.frames.filter((frame) => (
      frame.phase === 'transition'
      && frame.transitionFromSceneId === source.id
      && frame.transitionToSceneId === destination.id
    ))
    return {
      destination,
      plan: createZoomTimelinePlan(frames, source, destination),
      source,
    }
  })
  const holdFramesByScene = new Map(views.map((view) => [
    view.id,
    timeline.frames.filter((frame) => frame.phase === 'hold' && frame.sceneId === view.id),
  ]))
  const zoomCaptureCount = transitions.reduce(
    (total, transition) => total + transition.plan.timelines.reduce(
      (timelineTotal, zoomTimeline) => timelineTotal + zoomTimeline.captures.length,
      0,
    ),
    0,
  )
  const totalWork = views.length + timeline.frames.length + zoomCaptureCount
  const zoomCaptureSize = getZoomTimelineCaptureSize(size)
  let completedWork = 0
  let firstFinalImage: Blob | undefined
  const popupAnchors = new Map<string, PopupAnchor>()
  let rawFrameIndex = -1
  let captureViewport: Awaited<ReturnType<typeof createVideoCaptureViewport>> | undefined
  const reportFrameProgress = (detail: string) => {
    completedWork += 1
    progress({
      completed: completedWork,
      detail,
      phase: 'frames',
      total: totalWork,
    })
  }
  const rawFrameId = (
    sourceId: string,
    destinationId: string,
    captureId: string,
  ) => `${packageId}:transition:${sourceId}:${destinationId}:${captureId}`

  let captureError: unknown
  try {
    if (originalState.popup) {
      originalState.popup.visible = false
    }
    captureViewport = await createVideoCaptureViewport(
      session.map,
      views[0]?.viewpoint ?? {},
      size,
      signal,
    )
    const captureView = captureViewport.view

    for (const [viewIndex, view] of views.entries()) {
      signal.throwIfAborted()
      applyLayerStates(session.map, view.layers)
      await captureView.goTo(Viewpoint.fromJSON(view.viewpoint), { animate: false })
      const finalImage = await takeMapOnlyScreenshot(captureView, size, signal)
      firstFinalImage ??= finalImage
      if (view.popup) {
        try {
          const screenPoint = captureView.toScreen(Point.fromJSON(view.popup.location))
          if (
            screenPoint
            && Number.isFinite(screenPoint.x)
            && Number.isFinite(screenPoint.y)
          ) {
            popupAnchors.set(view.id, {
              x: Math.min(1, Math.max(0, screenPoint.x / size.width)),
              y: Math.min(1, Math.max(0, screenPoint.y / size.height)),
            })
          }
        } catch {
          popupAnchors.set(view.id, view.popup.anchor)
        }
      }
      reportFrameProgress(
        `Captured final view ${viewIndex + 1} of ${views.length} in the ${size.width}×${size.height} viewport`,
      )
      const holdFrames = holdFramesByScene.get(view.id)
      if (!holdFrames || holdFrames.length === 0) {
        throw new Error(`The final hold for “${view.name}” is missing.`)
      }
      for (const frame of holdFrames) {
        await putFrame(
          {
            blob: finalImage,
            frameId: `${packageId}:${frame.index}`,
            index: frame.index,
            packageId,
            sceneId: frame.sceneId,
          },
          storage,
        )
        reportFrameProgress(
          `Staged final-view hold frame ${(frame.index + 1).toLocaleString()} of ${timeline.frames.length.toLocaleString()}`,
        )
      }
    }

    if (transitions.some((transition) => transition.plan.outputFrames.length > 0)) {
      await captureViewport.resize(zoomCaptureSize, signal)
    }
    for (const [transitionIndex, transition] of transitions.entries()) {
      const transitionLabel = `${transition.source.name} to ${transition.destination.name}`
      for (const [zoomIndex, zoomTimeline] of transition.plan.timelines.entries()) {
        for (const [captureIndex, capture] of zoomTimeline.captures.entries()) {
          signal.throwIfAborted()
          applyLayerStates(session.map, capture.layers)
          await captureView.goTo(Viewpoint.fromJSON(capture.viewpoint), { animate: false })
          const blob = await takeMapOnlyScreenshot(captureView, zoomCaptureSize, signal)
          await putFrame(
            {
              blob,
              frameId: rawFrameId(
                transition.source.id,
                transition.destination.id,
                capture.captureId,
              ),
              index: rawFrameIndex,
              packageId,
            },
            storage,
          )
          rawFrameIndex -= 1
          reportFrameProgress(
            `Captured zoom timeline ${zoomIndex + 1} of ${transition.plan.timelines.length} for ${transitionLabel}, frame ${captureIndex + 1} of ${zoomTimeline.captures.length}`,
          )
        }
      }

      for (const outputFrame of transition.plan.outputFrames) {
        signal.throwIfAborted()
        const images = await Promise.all(outputFrame.contributions.map(async (contribution) => {
          const frameId = rawFrameId(
            transition.source.id,
            transition.destination.id,
            contribution.captureId,
          )
          const capturedFrame = await getFrameById(packageId, frameId)
          if (!capturedFrame) {
            throw new Error(
              `Zoom timeline image for video frame ${outputFrame.index + 1} is missing.`,
            )
          }
          return {
            blob: capturedFrame.blob,
            imageScale: contribution.imageScale,
            opacity: contribution.opacity,
          }
        }))
        const blob = await composeZoomTimelineFrame(
          images,
          size,
          signal,
        )
        await putFrame(
          {
            blob,
            frameId: `${packageId}:${outputFrame.index}`,
            index: outputFrame.index,
            packageId,
          },
          storage,
        )
        await Promise.all(outputFrame.contributions.map((contribution) => deleteFrame(
          packageId,
          rawFrameId(
            transition.source.id,
            transition.destination.id,
            contribution.captureId,
          ),
        )))
        reportFrameProgress(
          `Cross-faded transition ${transitionIndex + 1} of ${transitions.length}, frame ${(outputFrame.index + 1).toLocaleString()} of ${timeline.frames.length.toLocaleString()}`,
        )
      }
    }
  } catch (error) {
    captureError = error
  }

  const cleanupErrors: Error[] = []
  if (captureViewport) {
    try {
      captureViewport.destroy()
    } catch (error) {
      cleanupErrors.push(createCleanupError('Could not destroy the video capture viewport', error))
    }
  }
  try {
    await restoreOriginalMapState(session, originalState)
  } catch (error) {
    cleanupErrors.push(
      asError(error, 'Offline video capture could not restore the live map state.'),
    )
  }
  if (captureError && cleanupErrors.length > 0) {
    throw createAggregateError(
      'Offline video frame capture failed and the live map state could not be restored.',
      [
        asError(captureError, 'Offline video frame capture failed.'),
        ...cleanupErrors,
      ],
    )
  }
  if (cleanupErrors.length > 0) {
    throw createAggregateError(
      'Offline video capture could not clean up the live map state.',
      cleanupErrors,
    )
  }

  if (captureError) {
    throw captureError
  }
  if (!firstFinalImage) {
    throw new Error('The first final-view image is missing.')
  }
  return {
    popupAnchors,
    thumbnailBlob: firstFinalImage,
  }
}

export async function captureOfflineVideo({
  assets,
  options,
  packageId,
  session,
  views,
  warnings = [],
}: CaptureOfflineVideoInput): Promise<SavedVideoPackage> {
  const size = validateVideoOutputSize(options.outputSize)
  const timeline = createVideoTimeline(
    views,
    VIDEO_CAPTURE_FRAME_RATE,
    VIDEO_FINAL_VIEW_HOLD_MS,
    size,
  )
  const estimate = estimateVideoCapture(views, VIDEO_CAPTURE_FRAME_RATE, size)
  const payloadStorage = options.destination
    ? createDirectoryStorageReference(
        options.destination,
        'offline-video',
        `video-${packageId}`,
      )
    : { kind: 'browser' as const }
  const directoryStorage = payloadStorage.kind === 'directory'
    ? payloadStorage
    : undefined
  const captureWarnings = [...warnings]
  if (estimate && estimate.workingBytes >= largeWorkingCaptureBytes) {
    captureWarnings.push({
      code: 'large-capture',
      message: 'This capture required more than 250 MB of temporary frame storage.',
    })
  }

  const originalState = captureOriginalMapState(session)
  const stagingPackage: SavedVideoPackage = {
    byteSize: 0,
    createdAt: Date.now(),
    durationMs: timeline.durationMs,
    frameRate: VIDEO_CAPTURE_FRAME_RATE,
    height: size.height,
    item: session.item,
    itemData: session.itemData,
    packageId,
    payloadStorage,
    scenes: timeline.scenes,
    schemaVersion: VIDEO_PACKAGE_SCHEMA_VERSION,
    state: 'staging',
    thumbnailBlob: views[0].thumbnailBlob,
    videoMimeType: '',
    warnings: captureWarnings,
    width: size.width,
  }

  try {
    await putPackage(stagingPackage)
    options.onProgress({
      completed: 0,
      detail: 'Preparing atomic video package storage',
      phase: 'preparing',
      total: 1,
    })
    for (const asset of assets) {
      options.signal.throwIfAborted()
      await putAsset({ ...asset, packageId }, directoryStorage)
    }

    const capturedFrames = await captureTimelineFrames({
      originalState,
      packageId,
      progress: options.onProgress,
      session,
      signal: options.signal,
      size,
      storage: directoryStorage,
      timeline,
      views,
    })
    const capturedScenes = timeline.scenes.map((scene) => {
      const popupAnchor = capturedFrames.popupAnchors.get(scene.id)
      return popupAnchor && scene.popup
        ? {
            ...scene,
            popup: {
              ...scene.popup,
              anchor: popupAnchor,
            },
          }
        : scene
    })

    const encoded = await encodeVideoFrames({
      frameCount: timeline.frames.length,
      frameRate: VIDEO_CAPTURE_FRAME_RATE,
      getFrame: async (index) => {
        const frame = await getFrame(packageId, index)
        if (!frame) {
          throw new Error(`Temporary video frame ${index + 1} is missing.`)
        }
        return frame.blob
      },
      height: size.height,
      onProgress: options.onProgress,
      outputStorage: directoryStorage,
      signal: options.signal,
      width: size.width,
    })

    options.onProgress({
      completed: 0,
      detail: 'Verifying video duration and final-view timestamps',
      phase: 'verifying',
      total: 1,
    })
    const verifiedVideo = await verifyVideoBlob(
      encoded.blob,
      capturedScenes,
      timeline.durationMs,
      options.signal,
    )
    const assetBytes = assets.reduce((total, asset) => total + asset.blob.size, 0)
    const completed = await finalizePackage({
      ...stagingPackage,
      byteSize: encoded.blob.size + capturedFrames.thumbnailBlob.size + assetBytes,
      durationMs: verifiedVideo.durationMs,
      scenes: verifiedVideo.scenes,
      thumbnailBlob: capturedFrames.thumbnailBlob,
      videoBlob: directoryStorage ? undefined : encoded.blob,
      videoFilePath: directoryStorage ? encoded.fileName : undefined,
      videoMimeType: encoded.mimeType,
    })
    options.onProgress({
      completed: 1,
      detail: 'Offline video is ready',
      phase: 'complete',
      total: 1,
    })
    return completed
  } catch (error) {
    try {
      await deletePackage(packageId)
    } catch (cleanupError) {
      throw createAggregateError(
        'Offline video capture failed and staged data could not be cleaned up.',
        [
          asError(error, 'Offline video capture failed.'),
          createCleanupError('Could not delete the staging video package', cleanupError),
        ],
      )
    }
    throw error
  }
}
