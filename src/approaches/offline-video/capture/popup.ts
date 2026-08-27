import DOMPurify from 'dompurify'
import type MapView from '@arcgis/core/views/MapView.js'
import { toBlob as defaultToBlob } from 'html-to-image'
import {
  serializeArcGisJson,
  type JsonObject,
  type JsonValue,
} from '../../../shared/arcgis/index.ts'
import type {
  CapturedPopupContent,
  CapturedPopupField,
  CapturedPopupMediaItem,
  CapturedRelationshipRecord,
  PopupCaptureResult,
  VideoCaptureWarning,
  VideoPackageAsset,
} from '../types.ts'

type AssetKind = VideoPackageAsset['kind']
type HtmlToImageToBlob = typeof defaultToBlob

interface ArcGisSerializable {
  toJSON: () => object
}

interface ScreenPointLike {
  x: number
  y: number
}

interface PopupFieldInfoLike {
  fieldName?: string | null
  label?: string | null
  visible?: boolean | null
}

interface PopupOrderByFieldLike {
  field?: string | null
  order?: string | null
}

interface PopupFieldMetadataLike {
  alias?: string | null
  name?: string | null
}

interface PopupRelationLike {
  id?: number | null
}

interface GraphicLike {
  attributes?: Record<string, unknown> | null
  geometry?: ArcGisSerializable | Record<string, unknown> | null
  layer?: PopupAttachmentLayerLike | null
  popupTemplate?: {
    title?: string | null
  } | null
}

interface PopupAttachmentInfoLike {
  contentType?: string | null
  name?: string | null
  size?: number | null
  url?: string | null
}

interface PopupAttachmentLayerLike {
  objectIdField?: string | null
  queryAttachments?: (
    query: {
      attachmentTypes?: string[]
      keywords?: string[]
      objectIds: number[]
      orderByFields?: string[]
    },
    options?: {
      signal?: AbortSignal
    },
  ) => Promise<Record<string, PopupAttachmentInfoLike[]>>
}

interface PopupRelatedInfoLike {
  layerInfo?: {
    fields?: PopupFieldMetadataLike[] | null
    objectIdField?: string | null
  } | null
  relatedFeatures?: GraphicLike[] | null
  relatedFields?: string[] | null
  relatedStatsFeatures?: GraphicLike[] | null
  relation?: PopupRelationLike | null
}

interface PopupFeatureViewModelLike {
  content?: unknown
  formattedAttributes?: {
    content?: Array<Record<string, unknown>> | null
    global?: Record<string, unknown> | null
  } | null
  graphic?: GraphicLike | null
  location?: ArcGisSerializable | Record<string, unknown> | null
  relatedInfos?: Map<string, PopupRelatedInfoLike> | null
}

interface PopupLike {
  location?: ArcGisSerializable | Record<string, unknown> | null
  selectedFeature?: GraphicLike | null
  selectedFeatureWidget?: {
    viewModel?: PopupFeatureViewModelLike | null
  } | null
  title?: string | null
  viewModel?: {
    screenLocation?: ScreenPointLike | null
    selectedFeatureViewModel?: PopupFeatureViewModelLike | null
  } | null
  visible?: boolean | null
}

interface MapViewLike {
  container?: Element | null
  height: number
  popup: PopupLike
  toScreen?: (value: unknown) => ScreenPointLike
  width: number
}

interface PopupCaptureContext {
  feature: GraphicLike
  featureViewModel: PopupFeatureViewModelLike | null
}

interface PopupNormalizationState {
  assets: VideoPackageAsset[]
  capturedAssetUrls: Map<string, VideoPackageAsset>
  createAssetId: (kind: AssetKind) => string
  fallbackReasons: Set<string>
  fetch: typeof fetch
  packageId: string
  popupContentElement: HTMLElement | null
  signal?: AbortSignal
  toBlob: HtmlToImageToBlob
}

export interface PopupCaptureOptions {
  createAssetId?: (kind: AssetKind) => string
  fetch?: typeof fetch
  packageId: string
  popupContentElement?: HTMLElement | null
  signal?: AbortSignal
  toBlob?: HtmlToImageToBlob
  viewId?: string
}

export const OFFLINE_ASSET_URL_PREFIX = 'offline-asset:'

const forbiddenSanitizedHtmlTags = [
  'audio',
  'button',
  'canvas',
  'embed',
  'form',
  'iframe',
  'input',
  'math',
  'object',
  'script',
  'select',
  'slot',
  'style',
  'svg',
  'textarea',
  'video',
] as const

const unsafeDomTags = new Set([
  'audio',
  'button',
  'canvas',
  'embed',
  'form',
  'iframe',
  'input',
  'math',
  'object',
  'script',
  'select',
  'slot',
  'style',
  'svg',
  'textarea',
  'video',
])

const htmlAssetExtensions = new Set([
  '7z',
  'avi',
  'bmp',
  'csv',
  'doc',
  'docx',
  'geojson',
  'gif',
  'gz',
  'jpeg',
  'jpg',
  'json',
  'mov',
  'mp3',
  'mp4',
  'pdf',
  'png',
  'svg',
  'tif',
  'tiff',
  'txt',
  'wav',
  'webm',
  'webp',
  'xls',
  'xlsx',
  'xml',
  'zip',
])

const popupContentSelectors = [
  '[data-popup-content-root]',
  '.esri-popup__content',
  '.esri-features__content-feature',
  '.esri-feature__main-container',
] as const

export function sanitizePopupHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOW_UNKNOWN_PROTOCOLS: false,
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'style'],
    FORBID_TAGS: [...forbiddenSanitizedHtmlTags],
    USE_PROFILES: { html: true },
  })
}

export function createOfflineAssetToken(assetId: string): string {
  return `${OFFLINE_ASSET_URL_PREFIX}${assetId}`
}

export function normalizePopupAnchor(
  point: ScreenPointLike,
  size: Pick<MapViewLike, 'height' | 'width'>,
): { x: number; y: number } {
  if (!Number.isFinite(size.width) || size.width <= 0 || !Number.isFinite(size.height) || size.height <= 0) {
    throw new Error('Popup capture requires a view with a measurable size.')
  }

  return {
    x: clamp(point.x / size.width, 0, 1),
    y: clamp(point.y / size.height, 0, 1),
  }
}

export async function captureMapViewPopup(
  mapView: MapView,
  options: PopupCaptureOptions,
): Promise<PopupCaptureResult> {
  const view = mapView as unknown as MapViewLike
  const popup = view.popup
  const featureViewModel = popup.selectedFeatureWidget?.viewModel ?? popup.viewModel?.selectedFeatureViewModel ?? null
  const feature = popup.selectedFeature ?? featureViewModel?.graphic ?? null

  if (!popup.visible || !feature) {
    return { assets: [], warnings: [] }
  }

  const locationSource = popup.location ?? featureViewModel?.location ?? feature.geometry
  if (!locationSource) {
    throw new Error('Popup capture could not determine the selected popup location.')
  }

  const state: PopupNormalizationState = {
    assets: [],
    capturedAssetUrls: new Map<string, VideoPackageAsset>(),
    createAssetId: options.createAssetId ?? createDefaultAssetIdFactory(),
    fallbackReasons: new Set<string>(),
    fetch: options.fetch ?? fetch,
    packageId: options.packageId,
    popupContentElement: options.popupContentElement ?? findPopupContentElement(view.container ?? null),
    signal: options.signal,
    toBlob: options.toBlob ?? defaultToBlob,
  }

  const screenPoint = popup.viewModel?.screenLocation ?? view.toScreen?.(locationSource) ?? {
    x: view.width / 2,
    y: view.height / 2,
  }
  let normalizedContent: CapturedPopupContent[]
  try {
    normalizedContent = await normalizePopupContent(featureViewModel?.content, {
      feature,
      featureViewModel,
    }, state)
  } catch (error) {
    state.fallbackReasons.add(`Structured popup capture failed: ${describeError(error)}`)
    normalizedContent = [createAttributeFallbackContent(feature.attributes ?? {})]
  }

  if (state.fallbackReasons.size > 0) {
    try {
      normalizedContent.push(await captureFallbackImage(state))
    } catch (error) {
      state.fallbackReasons.add(`Popup image fallback failed: ${describeError(error)}`)
      if (normalizedContent.length === 0) {
        normalizedContent.push(createAttributeFallbackContent(feature.attributes ?? {}))
      }
    }
  }

  const popupResult = {
    anchor: normalizePopupAnchor(screenPoint, view),
    attributes: normalizeJsonObject(feature.attributes ?? {}),
    content: normalizedContent,
    fallbackReasons: [...state.fallbackReasons],
    location: normalizeArcGisValue(locationSource),
    title: await normalizeRetainedPopupHtml(
      popup.title
      ?? feature.popupTemplate?.title
      ?? '',
      state,
    ),
  }

  return {
    assets: state.assets,
    popup: popupResult,
    warnings: createWarningsForFallbacks(state.fallbackReasons, options.viewId),
  }
}

function createWarningsForFallbacks(
  fallbackReasons: ReadonlySet<string>,
  viewId?: string,
): VideoCaptureWarning[] {
  if (fallbackReasons.size === 0) {
    return []
  }

  return [{
    code: 'popup-fallback',
    message: `Popup capture used portable fallback content: ${[...fallbackReasons].join('; ')}`,
    viewId,
  }]
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }
  if (typeof error === 'string' && error.trim()) {
    return error
  }
  return 'An unexpected popup capture error occurred.'
}

function createAttributeFallbackContent(
  attributes: Record<string, unknown>,
): CapturedPopupContent {
  return {
    fields: Object.entries(attributes).map(([fieldName, value]) => ({
      fieldName,
      label: fieldName,
      value: formatPopupValue(value),
    })),
    title: 'Feature attributes',
    type: 'fields',
  }
}

function createDefaultAssetIdFactory(): (kind: AssetKind) => string {
  let nextId = 1

  return (kind) => {
    const randomPart = globalThis.crypto?.randomUUID?.() ?? String(nextId++)
    return `${kind}-${randomPart}`
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function findPopupContentElement(root: Element | null): HTMLElement | null {
  if (!(root instanceof Element)) {
    return null
  }

  for (const selector of popupContentSelectors) {
    const match = root.querySelector<HTMLElement>(selector)
    if (match) {
      return match
    }
  }

  return null
}

function isArcGisSerializable(value: unknown): value is ArcGisSerializable {
  return !!value && typeof value === 'object' && 'toJSON' in value && typeof value.toJSON === 'function'
}

function isPopupHTMLElement(value: unknown): value is HTMLElement {
  return typeof HTMLElement !== 'undefined' && value instanceof HTMLElement
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function normalizeArcGisValue(value: ArcGisSerializable | Record<string, unknown>): JsonObject {
  if (isArcGisSerializable(value)) {
    return serializeArcGisJson(value)
  }

  return normalizeJsonObject(value)
}

function normalizeJsonObject(value: Record<string, unknown>): JsonObject {
  const normalized: JsonObject = {}

  for (const [key, entry] of Object.entries(value)) {
    normalized[key] = normalizeJsonValue(entry)
  }

  return normalized
}

function normalizeJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value
  }
  if (value instanceof Date) {
    return value.toISOString()
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJsonValue(entry) ?? null)
  }
  if (isArcGisSerializable(value)) {
    return normalizeJsonObject(serializeArcGisJson(value))
  }
  if (isPlainObject(value)) {
    return normalizeJsonObject(value)
  }

  throw new Error('Popup capture encountered a non-serializable JSON value.')
}

async function normalizePopupContent(
  content: unknown,
  context: PopupCaptureContext,
  state: PopupNormalizationState,
): Promise<CapturedPopupContent[]> {
  if (content == null) {
    return []
  }
  if (typeof content === 'string') {
    return [{
      html: await normalizeRetainedPopupHtml(content, state),
      type: 'html',
    }]
  }
  if (typeof content === 'function') {
    state.fallbackReasons.add('ArcGIS popup content is still represented by a live function.')
    return []
  }
  if (isPopupHTMLElement(content)) {
    return normalizePopupDomContent(content, state)
  }
  if (Array.isArray(content)) {
    const normalized: CapturedPopupContent[] = []

    for (const [index, item] of content.entries()) {
      normalized.push(...await normalizePopupContentEntry(item, index, context, state))
    }

    return normalized
  }

  state.fallbackReasons.add('ArcGIS popup content is backed by a live widget that cannot be serialized safely.')
  return []
}

async function normalizePopupContentEntry(
  content: unknown,
  contentIndex: number,
  context: PopupCaptureContext,
  state: PopupNormalizationState,
): Promise<CapturedPopupContent[]> {
  if (content == null) {
    return []
  }
  if (typeof content === 'string') {
    return [{
      html: await normalizeRetainedPopupHtml(content, state),
      type: 'html',
    }]
  }
  if (typeof content === 'function') {
    state.fallbackReasons.add('ArcGIS popup content includes a live content function.')
    return []
  }
  if (isPopupHTMLElement(content)) {
    return await normalizePopupDomContent(content, state)
  }
  if (!content || typeof content !== 'object' || !('type' in content) || typeof content.type !== 'string') {
    state.fallbackReasons.add('ArcGIS popup content contains an unsupported live object.')
    return []
  }

  switch (content.type) {
    case 'attachments':
      return [await normalizeAttachmentsContent(content, context, state)]
    case 'custom':
      return await normalizeCustomContent(content, context, state)
    case 'expression':
      return [await normalizeExpressionContent(content, context, state)]
    case 'fields':
      return [await normalizeFieldsContent(content, contentIndex, context, state)]
    case 'media':
      return [await normalizeMediaContent(content, context, state)]
    case 'relationship':
      return [await normalizeRelationshipContent(content, context, state)]
    case 'text':
      return [{
        html: await normalizeRetainedPopupHtml(readOptionalString(content, 'text') ?? '', state),
        type: 'html',
      }]
    default:
      state.fallbackReasons.add(`ArcGIS popup content type “${content.type}” is not serializable.`)
      return []
  }
}

async function normalizeFieldsContent(
  content: Record<string, unknown>,
  contentIndex: number,
  context: PopupCaptureContext,
 state: PopupNormalizationState,
): Promise<CapturedPopupContent> {
 const fieldInfos = Array.isArray(content.fieldInfos)
   ? content.fieldInfos.filter(isVisiblePopupFieldInfo)
   : []

 return {
   description: await normalizeOptionalPopupHtml(content.description, state),
   fields: fieldInfos.map((fieldInfo) => normalizeField(fieldInfo, contentIndex, context)),
   title: await normalizeOptionalPopupHtml(content.title, state),
   type: 'fields',
 }
}

function isVisiblePopupFieldInfo(value: unknown): value is PopupFieldInfoLike {
  return !!value
    && typeof value === 'object'
    && (value as PopupFieldInfoLike).visible !== false
    && typeof (value as PopupFieldInfoLike).fieldName === 'string'
}

function normalizeField(
  fieldInfo: PopupFieldInfoLike,
  contentIndex: number,
  context: PopupCaptureContext,
): CapturedPopupField {
  const fieldName = fieldInfo.fieldName ?? ''
  const formattedAttributes = context.featureViewModel?.formattedAttributes
  const formattedContentValue = formattedAttributes?.content?.[contentIndex]?.[fieldName]
  const formattedGlobalValue = formattedAttributes?.global?.[fieldName]
  const rawValue = resolvePopupFieldValue(fieldName, context)

  return {
    fieldName,
    label: fieldInfo.label ?? fieldName,
    value: formatPopupValue(formattedContentValue ?? formattedGlobalValue ?? rawValue),
  }
}

async function normalizeMediaContent(
  content: Record<string, unknown>,
  context: PopupCaptureContext,
  state: PopupNormalizationState,
): Promise<CapturedPopupContent> {
  const mediaInfos = Array.isArray(content.mediaInfos) ? content.mediaInfos : []
  const items: CapturedPopupMediaItem[] = []

  for (const mediaInfo of mediaInfos) {
    if (!mediaInfo || typeof mediaInfo !== 'object' || !('type' in mediaInfo) || typeof mediaInfo.type !== 'string') {
      state.fallbackReasons.add('ArcGIS popup media includes an unsupported live entry.')
      continue
    }

    if (mediaInfo.type === 'image') {
      items.push(await normalizeImageMedia(mediaInfo, state))
      continue
    }

    items.push(await normalizeChartOrUnknownMedia(mediaInfo, context, state))
  }

  return {
    items,
    title: await normalizeOptionalPopupHtml(content.title, state),
    type: 'media',
  }
}

async function normalizeImageMedia(
  mediaInfo: Record<string, unknown>,
  state: PopupNormalizationState,
): Promise<CapturedPopupMediaItem> {
  const value = readOptionalObject(mediaInfo, 'value')
  const sourceUrl = readOptionalString(value, 'sourceURL')
  if (!sourceUrl) {
    throw new Error('Popup image media is missing a sourceURL.')
  }

  const asset = await fetchPopupAsset({
    contentType: undefined,
    fetchKind: 'Popup media asset',
    fileName: deriveFileName(sourceUrl),
    kind: 'popup-media',
    packageId: state.packageId,
    signal: state.signal,
    state,
    url: sourceUrl,
  })

  return {
    alt: await normalizeOptionalPopupHtml(readOptionalString(mediaInfo, 'altText') ?? readOptionalString(mediaInfo, 'caption'), state),
    assetId: asset.assetId,
    caption: await normalizeOptionalPopupHtml(mediaInfo.caption, state),
    kind: 'image',
    link: readOptionalString(value, 'linkURL') ?? undefined,
    title: await normalizeOptionalPopupHtml(mediaInfo.title, state),
  }
}

async function normalizeChartOrUnknownMedia(
  mediaInfo: Record<string, unknown>,
  context: PopupCaptureContext,
  state: PopupNormalizationState,
): Promise<CapturedPopupMediaItem> {
  const rawType = typeof mediaInfo.type === 'string' ? mediaInfo.type : ''
  const kind = isCapturedMediaKind(rawType) ? rawType : 'unknown'

  return {
    caption: await normalizeOptionalPopupHtml(mediaInfo.caption, state),
    chartData: kind === 'image' || kind === 'unknown' ? undefined : serializeChartData(mediaInfo, context),
    kind,
    title: await normalizeOptionalPopupHtml(mediaInfo.title, state),
  }
}

function isCapturedMediaKind(value: string): value is CapturedPopupMediaItem['kind'] {
  return value === 'bar-chart'
    || value === 'column-chart'
    || value === 'image'
    || value === 'line-chart'
    || value === 'pie-chart'
    || value === 'unknown'
}

function serializeChartData(
  mediaInfo: Record<string, unknown>,
  context: PopupCaptureContext,
): JsonObject {
  const value = readOptionalObject(mediaInfo, 'value')
  const fields = Array.isArray(value?.fields)
    ? value.fields.filter((entry): entry is string => typeof entry === 'string')
    : []
  const resolvedValues: Record<string, JsonValue> = {}

  for (const fieldName of fields) {
    resolvedValues[fieldName] = normalizeJsonValue(resolvePopupFieldValue(fieldName, context) ?? null) ?? null
  }

  const colors = Array.isArray(value?.colors)
    ? value.colors.map((entry) => normalizeJsonValue(entry))
    : undefined
  const series = Array.isArray(value?.series)
    ? value.series.map((entry) => normalizeJsonValue(entry))
    : undefined
  const tooltipField = readOptionalString(value, 'tooltipField')
  const normalizeField = readOptionalString(value, 'normalizeField')

  return normalizeJsonObject({
    colors,
    fields,
    normalizeField,
    normalizeValue: normalizeField ? resolvePopupFieldValue(normalizeField, context) ?? null : null,
    series,
    tooltipField,
    tooltipValue: tooltipField ? resolvePopupFieldValue(tooltipField, context) ?? null : null,
    values: resolvedValues,
  })
}

async function normalizeAttachmentsContent(
  content: Record<string, unknown>,
  context: PopupCaptureContext,
  state: PopupNormalizationState,
): Promise<CapturedPopupContent> {
  const layer = context.feature.layer
  if (!layer?.queryAttachments) {
    throw new Error('Popup attachments content requires a layer that supports queryAttachments().')
  }

  const objectIdField = layer.objectIdField
  if (!objectIdField) {
    throw new Error('Popup attachments content requires a layer objectIdField.')
  }

  const rawObjectId = context.feature.attributes?.[objectIdField]
  const objectId = typeof rawObjectId === 'number'
    ? rawObjectId
    : typeof rawObjectId === 'string' && rawObjectId.trim() !== ''
      ? Number(rawObjectId)
      : Number.NaN
  if (!Number.isInteger(objectId)) {
    throw new Error(`Popup attachments content requires a numeric object ID in “${objectIdField}”.`)
  }

  const attachmentsByObjectId = await layer.queryAttachments({
    attachmentTypes: readStringArray(content, 'attachmentTypes'),
    keywords: readStringArray(content, 'attachmentKeywords'),
    objectIds: [objectId],
    orderByFields: normalizeOrderByFields(content.orderByFields),
  }, {
    signal: state.signal,
  })
  const attachmentInfos = attachmentsByObjectId[String(objectId)] ?? []

  return {
    items: await Promise.all(attachmentInfos.map(async (attachmentInfo) => {
      const url = attachmentInfo.url
      if (!url) {
        throw new Error('Popup attachment info is missing a URL.')
      }
      const asset = await fetchPopupAsset({
        contentType: attachmentInfo.contentType ?? undefined,
        fetchKind: 'Popup attachment asset',
        fileName: attachmentInfo.name ?? deriveFileName(url),
        kind: 'attachment',
        packageId: state.packageId,
        signal: state.signal,
        state,
        url,
      })

      return {
        assetId: asset.assetId,
        contentType: asset.contentType,
        name: attachmentInfo.name ?? asset.fileName ?? asset.assetId,
        size: attachmentInfo.size ?? asset.blob.size,
      }
    })),
    title: await normalizeOptionalPopupHtml(content.title, state),
    type: 'attachments',
  }
}

function normalizeOrderByFields(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return []
    }

    const field = (entry as PopupOrderByFieldLike).field?.trim()
    if (!field) {
      return []
    }

    const rawOrder = (entry as PopupOrderByFieldLike).order?.trim().toLowerCase()
    const order = rawOrder === 'desc' || rawOrder === 'descending' ? 'DESC' : 'ASC'
    return [`${field} ${order}`]
  })
}

async function normalizeExpressionContent(
  content: Record<string, unknown>,
  context: PopupCaptureContext,
  state: PopupNormalizationState,
): Promise<CapturedPopupContent> {
  const resolvedContent = readResolvedPopupContentValue(content)
  if (resolvedContent === undefined) {
    state.fallbackReasons.add('ArcGIS expression popup content is not exposed as serializable resolved content.')
    return {
      content: [],
      title: await normalizeOptionalPopupHtml(content.title, state),
      type: 'expression',
    }
  }

  return {
    content: await normalizePopupContent(resolvedContent, context, state),
    title: await normalizeOptionalPopupHtml(content.title, state),
    type: 'expression',
  }
}

async function normalizeCustomContent(
  content: Record<string, unknown>,
  context: PopupCaptureContext,
  state: PopupNormalizationState,
): Promise<CapturedPopupContent[]> {
  const resolvedContent = readResolvedPopupContentValue(content)
  if (typeof resolvedContent === 'string') {
    return [{
      html: await normalizeRetainedPopupHtml(resolvedContent, state),
      type: 'html',
    }]
  }
  if (isPopupHTMLElement(resolvedContent)) {
    return await normalizePopupDomContent(resolvedContent, state)
  }
  if (Array.isArray(resolvedContent)) {
    return normalizePopupContent(resolvedContent, context, state)
  }

  state.fallbackReasons.add('ArcGIS custom popup content relies on live DOM or widget state.')
  return []
}

function readResolvedPopupContentValue(content: Record<string, unknown>): unknown {
  if ('resolvedContent' in content) {
    return content.resolvedContent
  }
  if ('content' in content && content.content != null) {
    return content.content
  }
  if ('html' in content && typeof content.html === 'string') {
    return content.html
  }
  if ('text' in content && typeof content.text === 'string') {
    return content.text
  }
  if ('value' in content && content.value != null && !isArcGisSerializable(content.value)) {
    return content.value
  }

  return undefined
}

async function normalizePopupDomContent(
  element: HTMLElement,
  state: PopupNormalizationState,
): Promise<CapturedPopupContent[]> {
  if (containsUnsafeDomContent(element)) {
    state.fallbackReasons.add('ArcGIS popup DOM content contains live or unsafe elements that require a fallback image.')
    return []
  }

  return [{
    html: await normalizeRetainedPopupHtml(element.outerHTML, state),
    type: 'html',
  }]
}

function containsUnsafeDomContent(root: HTMLElement): boolean {
  const elements = [root, ...root.querySelectorAll<HTMLElement>('*')]

  for (const element of elements) {
    if (element.shadowRoot) {
      return true
    }
    if (element.tagName.includes('-')) {
      return true
    }
    if (unsafeDomTags.has(element.tagName.toLowerCase())) {
      return true
    }
    for (const attribute of element.getAttributeNames()) {
      if (attribute.startsWith('on')) {
        return true
      }
    }
  }

  return false
}

async function normalizeRetainedPopupHtml(
  html: string,
  state: PopupNormalizationState,
): Promise<string> {
  const sanitizedHtml = sanitizePopupHtml(html)
  if (sanitizedHtml.trim() === '') {
    return sanitizedHtml
  }

  const template = document.createElement('template')
  template.innerHTML = sanitizedHtml
  await rewriteHtmlAssetUrls(template.content, state)
  return template.innerHTML
}

async function rewriteHtmlAssetUrls(
  root: ParentNode,
  state: PopupNormalizationState,
): Promise<void> {
  const replacements = collectHtmlAssetReplacements(root)
  for (const replacement of replacements) {
    if (replacement.attributeName === 'srcset') {
      replacement.element.setAttribute('srcset', await rewriteSrcsetValue(replacement.attributeValue, state))
      continue
    }

    const asset = await captureHtmlAsset(replacement.element, replacement.attributeName, replacement.attributeValue, state)
    if (asset) {
      replacement.element.setAttribute(replacement.attributeName, createOfflineAssetToken(asset.assetId))
    }
  }
}

function collectHtmlAssetReplacements(root: ParentNode): Array<{
  attributeName: 'href' | 'src' | 'srcset'
  attributeValue: string
  element: HTMLElement
}> {
  const replacements: Array<{
    attributeName: 'href' | 'src' | 'srcset'
    attributeValue: string
    element: HTMLElement
  }> = []

  for (const element of root.querySelectorAll<HTMLElement>('[src], [srcset], a[href]')) {
    for (const attributeName of ['src', 'srcset', 'href'] as const) {
      const attributeValue = element.getAttribute(attributeName)?.trim()
      if (!attributeValue || !shouldCaptureHtmlAssetUrl(element, attributeName, attributeValue)) {
        continue
      }
      replacements.push({
        attributeName,
        attributeValue,
        element,
      })
    }
  }

  return replacements
}

function shouldCaptureHtmlAssetUrl(
  element: HTMLElement,
  attributeName: 'href' | 'src' | 'srcset',
  url: string,
): boolean {
  if (
    url.startsWith('#')
    || url.startsWith('javascript:')
    || url.startsWith('mailto:')
    || url.startsWith('tel:')
    || url.startsWith(OFFLINE_ASSET_URL_PREFIX)
  ) {
    return false
  }

  if (attributeName === 'href') {
    if (element.tagName !== 'A') {
      return false
    }
    return element.hasAttribute('download') || looksLikeHtmlLinkedAsset(url)
  }

  return true
}

function looksLikeHtmlLinkedAsset(url: string): boolean {
  const normalizedUrl = normalizeAssetUrlForLookup(url)
  const pathname = normalizedUrl.split('?')[0]?.split('#')[0] ?? normalizedUrl
  const extension = pathname.split('.').at(-1)?.toLowerCase()
  return !!extension && htmlAssetExtensions.has(extension)
}

async function rewriteSrcsetValue(
  srcset: string,
  state: PopupNormalizationState,
): Promise<string> {
  const candidates = srcset
    .split(',')
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0)

  const rewrittenCandidates: string[] = []
  for (const candidate of candidates) {
    const [url, ...descriptorParts] = candidate.split(/\s+/)
    const descriptor = descriptorParts.join(' ')
    const asset = await captureHtmlAsset(undefined, 'srcset', url, state)
    if (!asset) {
      rewrittenCandidates.push(candidate)
      continue
    }

    const rewrittenUrl = createOfflineAssetToken(asset.assetId)
    rewrittenCandidates.push(descriptor ? `${rewrittenUrl} ${descriptor}` : rewrittenUrl)
  }

  return rewrittenCandidates.join(', ')
}

async function captureHtmlAsset(
  element: HTMLElement | undefined,
  attributeName: 'href' | 'src' | 'srcset',
  url: string,
  state: PopupNormalizationState,
): Promise<VideoPackageAsset | undefined> {
  if (url.startsWith('data:')) {
    return undefined
  }

  const kind = attributeName === 'href' && element?.tagName === 'A' ? 'attachment' : 'popup-media'
  return fetchPopupAsset({
    contentType: undefined,
    fetchKind: 'Popup HTML asset',
    fileName: deriveFileName(url),
    kind,
    packageId: state.packageId,
    signal: state.signal,
    state,
    url,
  })
}

async function normalizeRelationshipContent(
  content: Record<string, unknown>,
  context: PopupCaptureContext,
  state: PopupNormalizationState,
): Promise<CapturedPopupContent> {
  const relationshipId = typeof content.relationshipId === 'number' ? content.relationshipId : undefined
  const relatedInfo = relationshipId == null
    ? undefined
    : resolveRelatedInfo(relationshipId, context.featureViewModel?.relatedInfos)
  const relatedFeatures = relatedInfo?.relatedStatsFeatures?.length
    ? relatedInfo.relatedStatsFeatures
    : relatedInfo?.relatedFeatures ?? []

  return {
    records: relatedFeatures.map((feature, index) => normalizeRelationshipRecord(feature, index, relatedInfo)),
    title: await normalizeOptionalPopupHtml(content.title, state),
    type: 'relationship',
  }
}

function resolveRelatedInfo(
  relationshipId: number,
  relatedInfos: Map<string, PopupRelatedInfoLike> | null | undefined,
): PopupRelatedInfoLike | undefined {
  if (!relatedInfos) {
    return undefined
  }

  return relatedInfos.get(String(relationshipId))
    ?? [...relatedInfos.values()].find((entry) => entry.relation?.id === relationshipId)
}

function normalizeRelationshipRecord(
  feature: GraphicLike,
  index: number,
  relatedInfo: PopupRelatedInfoLike | undefined,
): CapturedRelationshipRecord {
  const attributes = feature.attributes ?? {}
  const fieldMetadata = new Map(
    (relatedInfo?.layerInfo?.fields ?? [])
      .filter((field) => typeof field.name === 'string')
      .map((field) => [field.name as string, field.alias ?? undefined]),
  )
  const fieldNames = relatedInfo?.relatedFields?.length
    ? relatedInfo.relatedFields
    : (relatedInfo?.layerInfo?.fields ?? [])
      .map((field) => field.name)
      .filter((field): field is string => typeof field === 'string')
  const resolvedFieldNames = fieldNames.length > 0 ? fieldNames : Object.keys(attributes)
  const titleField = pickRelationshipTitleField(attributes, relatedInfo?.layerInfo?.objectIdField)

  return {
    fields: resolvedFieldNames.map((fieldName) => ({
      fieldName,
      label: fieldMetadata.get(fieldName) ?? fieldName,
      value: formatPopupValue(attributes[fieldName]),
    })),
    title: titleField ? formatPopupValue(attributes[titleField]) : `Related record ${index + 1}`,
  }
}

function pickRelationshipTitleField(
  attributes: Record<string, unknown>,
  objectIdField?: string | null,
): string | undefined {
  const preferredKeys = ['title', 'name', 'label', 'description']

  for (const preferredKey of preferredKeys) {
    const entry = Object.keys(attributes).find((key) => key.toLowerCase() === preferredKey)
    if (entry && attributes[entry] != null) {
      return entry
    }
  }

  return objectIdField && attributes[objectIdField] != null ? objectIdField : undefined
}

async function captureFallbackImage(state: PopupNormalizationState): Promise<CapturedPopupContent> {
  if (!state.popupContentElement) {
    throw new Error('Popup fallback capture could not find a popup-content-only element.')
  }

  const blob = await state.toBlob(state.popupContentElement, {
    cacheBust: true,
    pixelRatio: 1,
  })
  if (!blob) {
    throw new Error('Popup fallback capture failed to render a PNG image.')
  }

  const assetId = state.createAssetId('fallback-image')
  state.assets.push({
    assetId,
    blob,
    contentType: 'image/png',
    fileName: `${assetId}.png`,
    kind: 'fallback-image',
    packageId: state.packageId,
  })

  return {
    assetId,
    reason: [...state.fallbackReasons].join('; '),
    type: 'fallback-image',
  }
}

async function fetchPopupAsset(options: {
  contentType?: string
  fetchKind: string
  fileName?: string
  kind: Extract<AssetKind, 'attachment' | 'popup-media'>
  packageId: string
  signal?: AbortSignal
  state: PopupNormalizationState
  url: string
}): Promise<VideoPackageAsset> {
  const normalizedUrl = normalizeAssetUrlForLookup(options.url)
  const existingAsset = options.state.capturedAssetUrls.get(normalizedUrl)
  if (existingAsset) {
    return existingAsset
  }

  const response = await options.state.fetch(options.url, { signal: options.signal })
  if (!response.ok) {
    throw new Error(`${options.fetchKind} request failed with HTTP ${response.status}: ${options.url}`)
  }

  const blob = await response.blob()
  const contentType = options.contentType ?? response.headers.get('content-type') ?? blob.type ?? 'application/octet-stream'
  const assetId = options.state.createAssetId(options.kind)
  const asset: VideoPackageAsset = {
    assetId,
    blob,
    contentType,
    fileName: options.fileName,
    kind: options.kind,
    packageId: options.packageId,
  }
  options.state.capturedAssetUrls.set(normalizedUrl, asset)
  options.state.assets.push(asset)
  return asset
}

function normalizeAssetUrlForLookup(url: string): string {
  try {
    return new URL(url, document.baseURI).href
  } catch {
    return url
  }
}

function deriveFileName(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    const pathSegment = parsed.pathname.split('/').at(-1)?.trim()
    return pathSegment || undefined
  } catch {
    return undefined
  }
}

function resolvePopupFieldValue(
  fieldName: string,
  context: PopupCaptureContext,
): unknown {
  const attributes = context.feature.attributes ?? {}

  if (fieldName in attributes) {
    return attributes[fieldName]
  }
  if (fieldName.startsWith('relationships/')) {
    return resolveRelationshipFieldValue(fieldName, context.featureViewModel?.relatedInfos)
  }
  if (fieldName.startsWith('expression/')) {
    return attributes[fieldName]
  }

  return resolveNestedValue(attributes, fieldName.split('/'))
}

function resolveRelationshipFieldValue(
  fieldName: string,
  relatedInfos: Map<string, PopupRelatedInfoLike> | null | undefined,
): unknown {
  if (!relatedInfos) {
    return undefined
  }

  const [, relationshipKey, ...pathParts] = fieldName.split('/')
  const relatedInfo = relatedInfos.get(relationshipKey)
    ?? [...relatedInfos.values()][Number(relationshipKey)]
  if (!relatedInfo || pathParts.length === 0) {
    return undefined
  }

  const fieldPath = pathParts
  const relatedFeatures = relatedInfo.relatedStatsFeatures?.length
    ? relatedInfo.relatedStatsFeatures
    : relatedInfo.relatedFeatures ?? []
  const values = relatedFeatures
    .map((feature) => resolveNestedValue(feature.attributes ?? {}, fieldPath))
    .filter((value) => value !== undefined)

  if (values.length === 0) {
    return undefined
  }

  return values.length === 1 ? values[0] : values
}

function resolveNestedValue(
  source: Record<string, unknown>,
  path: string[],
): unknown {
  let current: unknown = source

  for (const segment of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current) || !(segment in current)) {
      return undefined
    }
    current = (current as Record<string, unknown>)[segment]
  }

  return current
}

function formatPopupValue(value: unknown): string {
  if (value == null) {
    return ''
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (value instanceof Date) {
    return value.toISOString()
  }
  if (Array.isArray(value)) {
    return value.map((entry) => formatPopupValue(entry)).join(', ')
  }
  if (isArcGisSerializable(value)) {
    return JSON.stringify(serializeArcGisJson(value))
  }
  if (isPlainObject(value)) {
    return JSON.stringify(normalizeJsonObject(value))
  }

  throw new Error('Popup capture could not format a field value.')
}

async function normalizeOptionalPopupHtml(
  value: unknown,
  state: PopupNormalizationState,
): Promise<string | undefined> {
  return typeof value === 'string' ? normalizeRetainedPopupHtml(value, state) : undefined
}

function readOptionalString(
  value: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  return value && typeof value[key] === 'string' ? value[key] as string : undefined
}

function readOptionalObject(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  return isPlainObject(value[key]) ? value[key] as Record<string, unknown> : undefined
}

function readStringArray(
  value: Record<string, unknown>,
  key: string,
): string[] | undefined {
  if (!Array.isArray(value[key])) {
    return undefined
  }

  return value[key].filter((entry): entry is string => typeof entry === 'string')
}
