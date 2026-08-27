import { describe, expect, it, vi } from 'vitest'
import {
  captureMapViewPopup,
  createOfflineAssetToken,
  normalizePopupAnchor,
  sanitizePopupHtml,
} from './popup.ts'

function createSerializable<T extends Record<string, unknown>>(value: T) {
  return {
    toJSON: () => value,
  }
}

describe('offline video popup capture', () => {
  it('returns no popup when the ArcGIS popup is not visible or selected', async () => {
    const invisible = await captureMapViewPopup({
      height: 200,
      popup: {
        selectedFeature: {
          attributes: {},
        },
        visible: false,
      },
      width: 300,
    } as never, {
      packageId: 'pkg-1',
    })

    const missingSelection = await captureMapViewPopup({
      height: 200,
      popup: {
        visible: true,
      },
      width: 300,
    } as never, {
      packageId: 'pkg-1',
    })

    expect(invisible).toEqual({ assets: [], warnings: [] })
    expect(missingSelection).toEqual({ assets: [], warnings: [] })
  })

  it('sanitizes popup html and clamps popup anchors to the view bounds', () => {
    expect(
      sanitizePopupHtml('<p onclick="hack()">Safe <strong>text</strong><script>alert(1)</script><img src=x></p>'),
    ).toBe('<p>Safe <strong>text</strong><img src="x"></p>')

    expect(normalizePopupAnchor({ x: -25, y: 275 }, { height: 200, width: 100 })).toEqual({
      x: 0,
      y: 1,
    })
  })

  it('rewrites retained HTML asset URLs to stable offline-asset tokens', async () => {
    const fetchMock = vi.fn<(typeof fetch)>().mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/inline.png')) {
        return new Response(new Blob(['png'], { type: 'image/png' }), {
          headers: { 'Content-Type': 'image/png' },
          status: 200,
        })
      }
      if (url.endsWith('/guide.pdf')) {
        return new Response(new Blob(['pdf'], { type: 'application/pdf' }), {
          headers: { 'Content-Type': 'application/pdf' },
          status: 200,
        })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    let nextImageId = 1
    let nextAttachmentId = 1
    const result = await captureMapViewPopup({
      height: 100,
      popup: {
        location: createSerializable({
          x: 1,
          y: 2,
          spatialReference: { wkid: 4326 },
        }),
        selectedFeature: {
          attributes: {},
        },
        selectedFeatureWidget: {
          viewModel: {
            content: '<p><img alt="Inline" src="https://example.test/inline.png"><img src="https://example.test/inline.png"><a download href="https://example.test/guide.pdf">Guide</a></p>',
          },
        },
        visible: true,
      },
      width: 200,
    } as never, {
      createAssetId: (kind) => {
        if (kind === 'popup-media') {
          return `popup-media-${nextImageId++}`
        }
        if (kind === 'attachment') {
          return `attachment-${nextAttachmentId++}`
        }
        return 'fallback-image-1'
      },
      fetch: fetchMock,
      packageId: 'pkg-html',
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.assets.map((asset) => asset.assetId)).toEqual(['popup-media-1', 'attachment-1'])
    expect(result.popup?.fallbackReasons).toEqual([])
    expect(result.popup?.content).toHaveLength(1)
    expect(result.popup?.content[0]).toMatchObject({
      type: 'html',
    })
    const htmlContent = result.popup?.content[0]
    expect(htmlContent?.type).toBe('html')
    const html = htmlContent?.type === 'html' ? htmlContent.html : ''
    expect(html).toContain(`src="${createOfflineAssetToken('popup-media-1')}"`)
    expect(html.match(new RegExp(createOfflineAssetToken('popup-media-1'), 'g'))).toHaveLength(2)
    expect(html).toContain(`href="${createOfflineAssetToken('attachment-1')}"`)
  })

  it('captures structured popup content, rewrites assets to IDs, and normalizes related data', async () => {
    const fetchMock = vi.fn<(typeof fetch)>().mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/photo.png')) {
        return new Response(new Blob(['png'], { type: 'image/png' }), {
          headers: { 'Content-Type': 'image/png' },
          status: 200,
        })
      }
      if (url.endsWith('/report.pdf')) {
        return new Response(new Blob(['pdf'], { type: 'application/pdf' }), {
          headers: { 'Content-Type': 'application/pdf' },
          status: 200,
        })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    let nextMediaId = 1
    let nextAttachmentId = 1
    const createAssetId = (kind: 'attachment' | 'fallback-image' | 'popup-media') => {
      switch (kind) {
        case 'attachment':
          return `attachment-${nextAttachmentId++}`
        case 'popup-media':
          return `popup-media-${nextMediaId++}`
        default:
          return 'fallback-image-1'
      }
    }

    const relatedInfos = new Map([
      ['3', {
        layerInfo: {
          fields: [
            { alias: 'Name', name: 'Name' },
            { alias: 'Score', name: 'score' },
          ],
          objectIdField: 'REL_OBJECTID',
        },
        relatedFeatures: [{
          attributes: {
            Name: 'Pump Station',
            score: 5,
          },
        }],
        relation: {
          id: 3,
        },
      }],
    ])

    const queryAttachments = vi.fn().mockResolvedValue({
      7: [{
        contentType: 'application/pdf',
        name: 'report.pdf',
        size: 3,
        url: 'https://example.test/report.pdf',
      }],
    })

    const result = await captureMapViewPopup({
      height: 200,
      popup: {
        location: createSerializable({
          latitude: 2,
          longitude: 1,
          spatialReference: { wkid: 4326 },
        }),
        selectedFeature: {
          attributes: {
            OBJECTID: 7,
            count: 12,
            total: 100,
          },
          layer: {
            objectIdField: 'OBJECTID',
            queryAttachments,
          },
          popupTemplate: {
            title: 'Template title',
          },
        },
        selectedFeatureWidget: {
          viewModel: {
            content: [
              {
                text: '<p onclick="hack()">Hello <strong>world</strong><script>alert(1)</script></p>',
                type: 'text',
              },
              {
                description: '<script>alert(1)</script>Summary',
                fieldInfos: [
                  { fieldName: 'count', label: 'Count' },
                  { fieldName: 'relationships/0/score', label: 'Scores' },
                ],
                title: '<em>Stats</em>',
                type: 'fields',
              },
              {
                mediaInfos: [
                  {
                    caption: '<i>Tree</i>',
                    title: '<b>Photo</b>',
                    type: 'image',
                    value: {
                      linkURL: 'https://example.test/details',
                      sourceURL: 'https://example.test/photo.png',
                    },
                  },
                  {
                    title: 'Totals',
                    type: 'pie-chart',
                    value: {
                      colors: ['red'],
                      fields: ['count'],
                      normalizeField: 'total',
                      tooltipField: 'count',
                    },
                  },
                ],
                title: 'Media',
                type: 'media',
              },
              {
                attachmentKeywords: ['summary'],
                attachmentTypes: ['application/pdf'],
                title: 'Files',
                type: 'attachments',
              },
              {
                relationshipId: 3,
                title: '<b>Related</b>',
                type: 'relationship',
              },
              {
                html: '<div><span>Custom</span></div>',
                type: 'custom',
              },
              {
                content: [{
                  text: '<span>Nested</span>',
                  type: 'text',
                }],
                title: 'Expression',
                type: 'expression',
              },
            ],
            formattedAttributes: {
              content: [
                {},
                { count: '12 formatted' },
              ],
              global: { total: '100 formatted' },
            },
            relatedInfos,
          },
        },
        title: '<h3>Popup<script>alert(1)</script></h3>',
        viewModel: {
          screenLocation: { x: 150, y: 50 },
        },
        visible: true,
      },
      width: 300,
    } as never, {
      createAssetId,
      fetch: fetchMock,
      packageId: 'pkg-1',
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(queryAttachments).toHaveBeenCalledWith({
      attachmentTypes: ['application/pdf'],
      keywords: ['summary'],
      objectIds: [7],
      orderByFields: undefined,
    }, {
      signal: undefined,
    })
    expect(result.warnings).toEqual([])
    expect(result.assets.map((asset) => ({
      assetId: asset.assetId,
      contentType: asset.contentType,
      kind: asset.kind,
    }))).toEqual([
      {
        assetId: 'popup-media-1',
        contentType: 'image/png',
        kind: 'popup-media',
      },
      {
        assetId: 'attachment-1',
        contentType: 'application/pdf',
        kind: 'attachment',
      },
    ])
    expect(result.popup).toEqual({
      anchor: {
        x: 0.5,
        y: 0.25,
      },
      attributes: {
        OBJECTID: 7,
        count: 12,
        total: 100,
      },
      content: [
        {
          html: '<p>Hello <strong>world</strong></p>',
          type: 'html',
        },
        {
          description: 'Summary',
          fields: [
            {
              fieldName: 'count',
              label: 'Count',
              value: '12 formatted',
            },
            {
              fieldName: 'relationships/0/score',
              label: 'Scores',
              value: '5',
            },
          ],
          title: '<em>Stats</em>',
          type: 'fields',
        },
        {
          items: [
            {
              alt: '<i>Tree</i>',
              assetId: 'popup-media-1',
              caption: '<i>Tree</i>',
              kind: 'image',
              link: 'https://example.test/details',
              title: '<b>Photo</b>',
            },
            {
              caption: undefined,
              chartData: {
                colors: ['red'],
                fields: ['count'],
                normalizeField: 'total',
                normalizeValue: 100,
                series: undefined,
                tooltipField: 'count',
                tooltipValue: 12,
                values: {
                  count: 12,
                },
              },
              kind: 'pie-chart',
              title: 'Totals',
            },
          ],
          title: 'Media',
          type: 'media',
        },
        {
          items: [{
            assetId: 'attachment-1',
            contentType: 'application/pdf',
            name: 'report.pdf',
            size: 3,
          }],
          title: 'Files',
          type: 'attachments',
        },
        {
          records: [{
            fields: [
              {
                fieldName: 'Name',
                label: 'Name',
                value: 'Pump Station',
              },
              {
                fieldName: 'score',
                label: 'Score',
                value: '5',
              },
            ],
            title: 'Pump Station',
          }],
          title: '<b>Related</b>',
          type: 'relationship',
        },
        {
          html: '<div><span>Custom</span></div>',
          type: 'html',
        },
        {
          content: [{
            html: '<span>Nested</span>',
            type: 'html',
          }],
          title: 'Expression',
          type: 'expression',
        },
      ],
      fallbackReasons: [],
      location: {
        latitude: 2,
        longitude: 1,
        spatialReference: { wkid: 4326 },
      },
      title: '<h3>Popup</h3>',
    })
  })

  it('captures a popup-content-only fallback image and warning for unsafe live DOM content', async () => {
    const popupContentElement = document.createElement('section')
    popupContentElement.setAttribute('data-popup-content-root', 'true')
    popupContentElement.innerHTML = '<p>Popup only</p>'

    const viewContainer = document.createElement('div')
    viewContainer.innerHTML = '<div id="map">map</div>'
    viewContainer.append(popupContentElement)

    const unsafeContent = document.createElement('div')
    unsafeContent.innerHTML = '<canvas></canvas><p>Interactive popup</p>'

    const toBlob = vi.fn().mockResolvedValue(new Blob(['fallback'], { type: 'image/png' }))

    const result = await captureMapViewPopup({
      container: viewContainer,
      height: 200,
      popup: {
        location: createSerializable({
          x: 1,
          y: 2,
          spatialReference: { wkid: 4326 },
        }),
        selectedFeature: {
          attributes: {},
        },
        selectedFeatureWidget: {
          viewModel: {
            content: unsafeContent,
          },
        },
        viewModel: {
          screenLocation: { x: 30, y: 40 },
        },
        visible: true,
      },
      width: 400,
    } as never, {
      createAssetId: () => 'fallback-image-1',
      packageId: 'pkg-2',
      toBlob,
      viewId: 'view-1',
    })

    expect(toBlob).toHaveBeenCalledTimes(1)
    expect(toBlob.mock.calls[0]?.[0]).toBe(popupContentElement)
    expect(result.assets.map((asset) => asset.kind)).toEqual(['fallback-image'])
    expect(result.popup?.content).toEqual([{
      assetId: 'fallback-image-1',
      reason: 'ArcGIS popup DOM content contains live or unsafe elements that require a fallback image.',
      type: 'fallback-image',
    }])
    expect(result.popup?.fallbackReasons).toEqual([
      'ArcGIS popup DOM content contains live or unsafe elements that require a fallback image.',
    ])
    expect(result.warnings).toEqual([{
      code: 'popup-fallback',
      message: 'Popup capture used portable fallback content: ArcGIS popup DOM content contains live or unsafe elements that require a fallback image.',
      viewId: 'view-1',
    }])
  })

  it('retains feature attributes when the visual popup fallback cannot render', async () => {
    const container = document.createElement('div')
    const popupContent = document.createElement('div')
    popupContent.className = 'esri-popup__content'
    container.append(popupContent)
    const result = await captureMapViewPopup({
      container,
      height: 200,
      popup: {
        location: { x: 10, y: 20 },
        selectedFeature: {
          attributes: { NAME: 'Fallback feature', VALUE: 42 },
          geometry: { x: 10, y: 20 },
        },
        selectedFeatureWidget: {
          viewModel: {
            content: { liveWidget: true },
          },
        },
        visible: true,
      },
      toScreen: () => ({ x: 100, y: 50 }),
      width: 400,
    } as never, {
      packageId: 'pkg-failed-image',
      toBlob: vi.fn().mockRejectedValue('SVG render failed'),
      viewId: 'view-failed-image',
    })

    expect(result.popup?.content).toEqual([{
      fields: [
        { fieldName: 'NAME', label: 'NAME', value: 'Fallback feature' },
        { fieldName: 'VALUE', label: 'VALUE', value: '42' },
      ],
      title: 'Feature attributes',
      type: 'fields',
    }])
    expect(result.popup?.fallbackReasons).toContain(
      'Popup image fallback failed: SVG render failed',
    )
    expect(result.warnings[0]).toMatchObject({
      code: 'popup-fallback',
      viewId: 'view-failed-image',
    })
  })
})
