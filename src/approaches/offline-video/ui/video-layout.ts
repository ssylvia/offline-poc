export interface MediaContentRect {
  height: number
  left: number
  top: number
  width: number
}

export function getContainedMediaRect(
  containerWidth: number,
  containerHeight: number,
  mediaWidth: number,
  mediaHeight: number,
): MediaContentRect {
  if (
    containerWidth <= 0
    || containerHeight <= 0
    || mediaWidth <= 0
    || mediaHeight <= 0
  ) {
    return { height: 0, left: 0, top: 0, width: 0 }
  }

  const scale = Math.min(containerWidth / mediaWidth, containerHeight / mediaHeight)
  const width = mediaWidth * scale
  const height = mediaHeight * scale
  return {
    height,
    left: (containerWidth - width) / 2,
    top: (containerHeight - height) / 2,
    width,
  }
}
