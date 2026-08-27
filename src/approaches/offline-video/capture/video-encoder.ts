import {
  BufferTarget,
  CanvasSource,
  getFirstEncodableVideoCodec,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  WebMOutputFormat,
} from 'mediabunny'
import type { VideoCodec } from 'mediabunny'
import {
  createPackageWritable,
  readPackageFile,
  type DirectoryPayloadStorage,
} from '../../../shared/storage/directory.ts'
import type { VideoCaptureProgress, VideoOutputSize } from '../types.ts'

const preferredVideoCodecs = ['vp8', 'vp9'] as const satisfies readonly VideoCodec[]
const supportedVideoCodecs = ['avc', ...preferredVideoCodecs] as const satisfies readonly VideoCodec[]
const videoBitrate = 5_000_000
const keyFrameIntervalSeconds = 1

type PreferredVideoCodec = (typeof preferredVideoCodecs)[number]
type SupportedVideoCodec = (typeof supportedVideoCodecs)[number]

interface VideoEncodingProfile {
  codec: SupportedVideoCodec
  extension: 'mp4' | 'webm'
  mimeType: 'video/mp4' | 'video/webm'
}

interface EncodeVideoFramesOptions extends VideoOutputSize {
  frameCount: number
  frameRate: number
  getFrame: (index: number) => Promise<Blob>
  onProgress: (progress: VideoCaptureProgress) => void
  outputStorage?: DirectoryPayloadStorage
  signal: AbortSignal
}

interface VideoEncodingSession {
  output: Output
  profile: VideoEncodingProfile
  source: CanvasSource
  target: BufferTarget | StreamTarget
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

function isSupportedVideoCodec(codec: VideoCodec | null): codec is SupportedVideoCodec {
  return codec === 'avc' || isPreferredVideoCodec(codec)
}

function getVideoEncodingProfile(codec: SupportedVideoCodec): VideoEncodingProfile {
  return codec === 'avc'
    ? { codec, extension: 'mp4', mimeType: 'video/mp4' }
    : { codec, extension: 'webm', mimeType: 'video/webm' }
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
    [...supportedVideoCodecs],
    { quality: new Quality({ bitrate: videoBitrate }) },
  )
  if (!isSupportedVideoCodec(codec)) {
    return undefined
  }
  return codec === 'avc'
    ? 'video/mp4;codecs=avc1.42E01E'
    : `video/webm;codecs=${codec}`
}

async function createVideoEncodingSession(options: {
  canvas: HTMLCanvasElement
  frameCount: number
  frameRate: number
  profile: VideoEncodingProfile
  signal: AbortSignal
  target: BufferTarget | StreamTarget
}): Promise<VideoEncodingSession> {
  const { canvas, frameCount, frameRate, profile, signal, target } = options
  const quality = new Quality({ bitrate: videoBitrate })

  signal.throwIfAborted()

  const output = new Output({
    format: profile.extension === 'mp4'
      ? new Mp4OutputFormat({ fastStart: 'reserve' })
      : new WebMOutputFormat(),
    target,
  })
  const source = new CanvasSource(canvas, {
    codec: profile.codec,
    keyFrameInterval: keyFrameIntervalSeconds,
    quality,
  })
  output.addVideoTrack(source, {
    frameRate,
    maximumPacketCount: Math.ceil(frameCount * 4 / 3),
  })
  try {
    await output.start()
    signal.throwIfAborted()
  } catch (error) {
    const cleanupErrors: Error[] = []
    try {
      source.close()
    } catch (cleanupError) {
      cleanupErrors.push(createCleanupError('Could not close the video source', cleanupError))
    }
    try {
      await output.cancel()
    } catch (cleanupError) {
      cleanupErrors.push(createCleanupError('Could not cancel the video encoder output', cleanupError))
    }
    if (cleanupErrors.length > 0) {
      throw createAggregateError(
        'The browser failed while starting the video encoder.',
        [asError(error, 'The browser failed while starting the video encoder.'), ...cleanupErrors],
      )
    }
    throw error
  }

  return { output, profile, source, target }
}

export async function encodeVideoFrames({
  frameCount,
  frameRate,
  getFrame,
  height,
  onProgress,
  outputStorage,
  signal,
  width,
}: EncodeVideoFramesOptions): Promise<{ blob: Blob; fileName: string; mimeType: string }> {
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

  const quality = new Quality({ bitrate: videoBitrate })
  const codec = await getFirstEncodableVideoCodec([...supportedVideoCodecs], {
    height,
    quality,
    width,
  })
  signal.throwIfAborted()
  if (!isSupportedVideoCodec(codec)) {
    throw new Error('This browser cannot encode a supported offline video.')
  }
  const profile = getVideoEncodingProfile(codec)
  const fileName = `video.${profile.extension}`
  let writable: FileSystemWritableFileStream | undefined
  if (outputStorage) {
    writable = await createPackageWritable(outputStorage, fileName)
    if (signal.aborted) {
      try {
        await writable.abort(signal.reason)
      } catch (cleanupError) {
        throw createAggregateError(
          'Video encoding was cancelled and its output file could not be closed.',
          [
            asError(signal.reason, 'Video encoding was cancelled.'),
            createCleanupError('Could not abort the video output file', cleanupError),
          ],
        )
      }
      signal.throwIfAborted()
    }
  }
  const target = writable ? new StreamTarget(writable) : new BufferTarget()
  const session = await createVideoEncodingSession({
    canvas,
    frameCount,
    frameRate,
    profile,
    signal,
    target,
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
  let result: { blob: Blob; fileName: string; mimeType: string } | undefined
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

    if (session.target instanceof BufferTarget) {
      const buffer = session.target.buffer
      if (!buffer || buffer.byteLength === 0) {
        throw new Error('The browser produced an empty video.')
      }
      result = {
        blob: new Blob([buffer], { type: session.profile.mimeType }),
        fileName,
        mimeType: session.profile.mimeType,
      }
    } else if (outputStorage) {
      const file = await readPackageFile(outputStorage, fileName)
      if (file.size === 0) {
        throw new Error('The browser produced an empty video file.')
      }
      result = {
        blob: file.type ? file : new Blob([file], { type: session.profile.mimeType }),
        fileName,
        mimeType: session.profile.mimeType,
      }
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
      cleanupErrors.push(createCleanupError('Could not close the video source', error))
    }
  }
  if (!finalized) {
    try {
      await cancelOutput()
    } catch (error) {
      cleanupErrors.push(createCleanupError('Could not cancel the video encoder output', error))
    }
  } else if (cleanupPromise) {
    try {
      await cleanupPromise
    } catch (error) {
      cleanupErrors.push(createCleanupError('Could not finish aborting the video encoder output', error))
    }
  }

  if (cleanupErrors.length > 0) {
    if (failure) {
      throw createAggregateError(
        'The browser failed while cleaning up the video encoder.',
        [asError(failure, 'The browser failed while encoding the video.'), ...cleanupErrors],
      )
    }
    throw createAggregateError('The browser failed while cleaning up the video encoder.', cleanupErrors)
  }
  if (failure) {
    throw failure
  }
  if (!result) {
    throw new Error('The browser failed while encoding the WebM video.')
  }

  return result
}
