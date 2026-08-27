import { useEffect, useState } from 'react'

export function useObjectUrl(blob?: Blob): string | undefined {
  const [url, setUrl] = useState<string>()

  useEffect(() => {
    if (!blob) {
      // The URL is effect-owned so Strict Mode cleanup cannot leave a revoked render-time URL.
      // oxlint-disable-next-line react/set-state-in-effect
      setUrl(undefined)
      return
    }
    const nextUrl = URL.createObjectURL(blob)
    setUrl(nextUrl)
    return () => {
      URL.revokeObjectURL(nextUrl)
    }
  }, [blob])

  return url
}

export function useObjectUrlMap(
  blobs: ReadonlyArray<readonly [string, Blob]>,
): Map<string, string> {
  const [urls, setUrls] = useState<Map<string, string>>(() => new Map())

  useEffect(() => {
    const nextUrls = new Map(
      blobs.map(([id, blob]) => [id, URL.createObjectURL(blob)]),
    )
    // oxlint-disable-next-line react/set-state-in-effect
    setUrls(nextUrls)
    return () => {
      for (const url of nextUrls.values()) {
        URL.revokeObjectURL(url)
      }
    }
  }, [blobs])

  return urls
}
