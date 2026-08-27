import {
  BufferTarget,
  CanvasSource,
  getFirstEncodableVideoCodec,
  Output,
  Quality,
  WebMOutputFormat,
} from 'mediabunny'
import type { VideoCodec } from 'mediabunny'
import type { VideoCaptureProgress, VideoOutputSize } from '../types.ts'

const preferredVideoCodecs = ['vp9', 'vp8'] as const satisfies readonly VideoCodec[]
const videoBitrate = 5_000_000
const keyFrameIntervalSeconds = 1
const videoMimeType = 'video/webm'

type PreferredVideoCodec = (typeof preferredVideoCodecs)[number]

interface EncodeVideoFramesOptions extends VideoOutputSize {
  frameCount: number
  frameRate: number
  getFrame: (index: number) => Promise<Blob>
  onProgress: (progress: VideoCaptureProgress) => void
  signal: AbortSignal
}

interface WebMEncodingSession {
  output: Output
  source: CanvasSource
  target: BufferTarget
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

function isPreferredVideoCodec(codec: VideoCodec | null): codec is PreferredVideoCodec {
  return codec === 'vp9' || codec === 'vp8'
}

export function selectPreferredVideoCodec(codecs: readonly VideoCodec[]): PreferredVideoCodec | undefined {
  return preferredVideoCodecs.find((codec) => codecs.includes(codec))
}

export function shouldForceVideoKeyFrame(frameIndex: number, frameRate: number): boolean {
  if (frameIndex === 0) {
    return true
  }
  const framesPerKeyFrame = Math.max(1, Math.round(frameRate * keyFrameIntervalSeconds))
  return frameIndex % framesPerKeyFrame === 0
}

export async function getSupportedVideoMimeType(): Promise<string | undefined> {
  const codec = await getFirstEncodableVideoCodec(
    [...preferredVideoCodecs],
    { quality: new Quality({ bitrate: videoBitrate }) },
  )
  return isPreferredVideoCodec(codec) ? `${videoMimeType};codecs=${codec}` : undefined
}

async function createWebMEncodingSession(options: {
  canvas: HTMLCanvasElement
  frameCount: number
  frameRate: number
  height: number
  signal: AbortSignal
  width: number
}): Promise<WebMEncodingSession> {
  const { canvas, frameCount, frameRate, height, signal, width } = options
  const quality = new Quality({ bitrate: videoBitrate })

  signal.throwIfAborted()
  const codec = await getFirstEncodableVideoCodec([...preferredVideoCodecs], {
    height,
    quality,
    width,
  })
  signal.throwIfAborted()
  if (!isPreferredVideoCodec(codec)) {
    throw new Error('This browser cannot encode a supported WebM video.')
  }

  const target = new BufferTarget()
  const output = new Output({
    format: new WebMOutputFormat({
      appendOnly: false,
      minimumClusterDuration: keyFrameIntervalSeconds,
    }),
    target,
  })
  const source = new CanvasSource(canvas, {
    codec,
    keyFrameInterval: keyFrameIntervalSeconds,
    quality,
  })
  output.addVideoTrack(source, {
    frameRate,
    maximumPacketCount: frameCount,
  })
  try {
    await output.start()
  } catch (error) {
    const cleanupErrors: Error[] = []
    try {
      source.close()
    } catch (cleanupError) {
      cleanupErrors.push(createCleanupError('Could not close the WebM video source', cleanupError))
    }
    try {
      await output.cancel()
    } catch (cleanupError) {
      cleanupErrors.push(createCleanupError('Could not cancel the WebM encoder output', cleanupError))
    }
    if (cleanupErrors.length > 0) {
      throw createAggregateError(
        'The browser failed while starting the WebM encoder.',
        [asError(error, 'The browser failed while starting the WebM encoder.'), ...cleanupErrors],
      )
    }
    throw error
  }

  return { output, source, target }
}

export async function encodeVideoFrames({
  frameCount,
  frameRate,
  getFrame,
  height,
  onProgress,
  signal,
  width,
}: EncodeVideoFramesOptions): Promise<{ blob: Blob; mimeType: string }> {
  if (frameCount <= 0) {
    throw new Error('At least one frame is required to encode a video.')
  }
  if (frameRate <= 0) {
    throw new Error('Video frame rate must be greater than zero.')
  }
  signal.throwIfAborted()

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) {
    throw new Error('The browser could not create a video encoding canvas.')
  }

  const session = await createWebMEncodingSession({
    canvas,
    frameCount,
    frameRate,
    height,
    signal,
    width,
  })
  let sourceClosed = false
  let cleanupPromise: Promise<void> | undefined
  const cancelOutput = () => {
    if (cleanupPromise || session.output.state === 'canceled' || session.output.state === 'finalized') {
      return cleanupPromise
    }
    cleanupPromise = session.output.cancel()
    return cleanupPromise
  }
  const handleAbort = () => {
    void cancelOutput()
  }
  signal.addEventListener('abort', handleAbort, { once: true })

  let finalized = false
  let failure: unknown
  let result: { blob: Blob; mimeType: string } | undefined
  try {
    const frameDurationSeconds = 1 / frameRate
    for (let index = 0; index < frameCount; index += 1) {
      signal.throwIfAborted()
      const frame = await getFrame(index)
      signal.throwIfAborted()
      const bitmap = await createImageBitmap(frame)
      signal.throwIfAborted()
      try {
        context.drawImage(bitmap, 0, 0, width, height)
        await session.source.add(
          index * frameDurationSeconds,
          frameDurationSeconds,
          shouldForceVideoKeyFrame(index, frameRate) ? { keyFrame: true } : undefined,
        )
      } finally {
        bitmap.close()
      }
      onProgress({
        completed: index + 1,
        detail: `Encoding frame ${(index + 1).toLocaleString()} of ${frameCount.toLocaleString()}`,
        phase: 'encoding',
        total: frameCount,
      })
    }

    signal.throwIfAborted()
    session.source.close()
    sourceClosed = true
    await session.output.finalize()
    finalized = true

    const buffer = session.target.buffer
    if (!buffer || buffer.byteLength === 0) {
      throw new Error('The browser produced an empty WebM video.')
    }
    result = {
      blob: new Blob([buffer], { type: videoMimeType }),
      mimeType: videoMimeType,
    }
  } catch (error) {
    failure = signal.aborted && signal.reason !== undefined ? signal.reason : error
  }

  signal.removeEventListener('abort', handleAbort)

  const cleanupErrors: Error[] = []
  if (!sourceClosed) {
    try {
      session.source.close()
      sourceClosed = true
    } catch (error) {
      cleanupErrors.push(createCleanupError('Could not close the WebM video source', error))
    }
  }
  if (!finalized) {
    try {
      await cancelOutput()
    } catch (error) {
      cleanupErrors.push(createCleanupError('Could not cancel the WebM encoder output', error))
    }
  } else if (cleanupPromise) {
    try {
      await cleanupPromise
    } catch (error) {
      cleanupErrors.push(createCleanupError('Could not finish aborting the WebM encoder output', error))
    }
  }

  if (cleanupErrors.length > 0) {
    if (failure) {
      throw createAggregateError(
        'The browser failed while cleaning up the WebM encoder.',
        [asError(failure, 'The browser failed while encoding the WebM video.'), ...cleanupErrors],
      )
    }
    throw createAggregateError('The browser failed while cleaning up the WebM encoder.', cleanupErrors)
  }
  if (failure) {
    throw failure
  }
  if (!result) {
    throw new Error('The browser failed while encoding the WebM video.')
  }

  return result
}
