import type {
  ExportedVideoAsset,
  SavedVideoPackage,
  VideoExportManifest,
  VideoPackageAsset,
} from './types.ts'

function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'offline-map'
}

export function getVideoExportBaseName(packageRecord: SavedVideoPackage): string {
  return `${slugify(packageRecord.item.title)}-${packageRecord.packageId.slice(-8)}`
}

function getVideoFileExtension(mimeType: string): 'mp4' | 'webm' {
  return mimeType.startsWith('video/mp4') ? 'mp4' : 'webm'
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('error', () => {
      reject(reader.error ?? new Error('A popup asset could not be encoded for export.'))
    }, { once: true })
    reader.addEventListener('load', () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('A popup asset produced an invalid export value.'))
        return
      }
      resolve(reader.result)
    }, { once: true })
    reader.readAsDataURL(blob)
  })
}

export async function createVideoExportManifest(
  packageRecord: SavedVideoPackage,
  assets: VideoPackageAsset[],
): Promise<VideoExportManifest> {
  if (!packageRecord.videoBlob) {
    throw new Error('The saved video package does not contain video data.')
  }
  const exportedAssets: ExportedVideoAsset[] = await Promise.all(assets.map(async (asset) => ({
    assetId: asset.assetId,
    contentType: asset.contentType,
    dataUrl: await blobToDataUrl(asset.blob),
    fileName: asset.fileName,
    kind: asset.kind,
  })))
  const baseName = getVideoExportBaseName(packageRecord)
  const extension = getVideoFileExtension(packageRecord.videoMimeType)

  return {
    assets: exportedAssets,
    createdAt: packageRecord.completedAt ?? packageRecord.createdAt,
    durationMs: packageRecord.durationMs,
    frameRate: packageRecord.frameRate,
    item: packageRecord.item,
    packageId: packageRecord.packageId,
    schemaVersion: packageRecord.schemaVersion,
    scenes: packageRecord.scenes,
    video: {
      fileName: `${baseName}.${extension}`,
      height: packageRecord.height,
      mimeType: packageRecord.videoMimeType,
      width: packageRecord.width,
    },
    warnings: packageRecord.warnings,
  }
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.download = fileName
  link.href = url
  link.rel = 'noopener'
  link.style.display = 'none'
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export async function exportVideoPackage(
  packageRecord: SavedVideoPackage,
  assets: VideoPackageAsset[],
): Promise<void> {
  if (!packageRecord.videoBlob) {
    throw new Error('The saved video package does not contain video data.')
  }

  const baseName = getVideoExportBaseName(packageRecord)
  const extension = getVideoFileExtension(packageRecord.videoMimeType)
  const manifest = await createVideoExportManifest(packageRecord, assets)
  downloadBlob(packageRecord.videoBlob, `${baseName}.${extension}`)
  downloadBlob(
    new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }),
    `${baseName}.json`,
  )
}
