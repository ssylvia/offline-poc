const portalResourceHosts = new Set([
  'cdn.arcgis.com',
  'www.arcgis.com',
])

export function canonicalizeOfflineResourceUrl(value: string): string {
  const url = new URL(value)
  url.hash = ''
  if (portalResourceHosts.has(url.hostname)) {
    url.hostname = 'arcgis.com'
  }
  if (
    url.pathname.includes('/sharing/rest/content/items/')
    && url.pathname.includes('/resources/')
    && url.searchParams.get('f')?.toLowerCase() === 'json'
  ) {
    url.searchParams.delete('f')
  }
  const entries = [...url.searchParams.entries()].sort(
    ([leftKey, leftValue], [rightKey, rightValue]) => (
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
    ),
  )
  url.search = ''
  for (const [key, entryValue] of entries) {
    url.searchParams.append(key, entryValue)
  }
  return url.href
}
