# Offline ArcGIS WebMap Viewer Prototype

A React + Vite PWA for public ArcGIS WebMaps with two browser-local offline approaches:

- **Interactive offline snapshot** — self-hosted ArcGIS Maps SDK assets plus bounded map/resource capture for later offline browsing.
- **Offline video package** — ordered final views rendered into a saved WebM video with popup metadata/assets for offline playback.

## Run locally

```bash
npm install
npm run dev
```

## Routes

Open the interactive snapshot workflow:

```text
http://localhost:5173/?webmap=<32-character-item-id>
```

Open a live WebMap in the offline video composer:

```text
http://localhost:5173/?approach=offline-video&webmap=<32-character-item-id>
```

Open a saved offline video package directly from browser storage:

```text
http://localhost:5173/?approach=offline-video&webmap=<32-character-item-id>&video-package=<saved-package-id>
```

Open an already-saved interactive snapshot route:

```text
http://localhost:5173/?webmap=<32-character-item-id>&view=offline
```

## Browser storage and PWA behavior

The production build:

- copies the pinned `@arcgis/core` runtime assets to `/arcgis-assets/`
- generates `/arcgis-runtime-manifest.json`
- precaches the app shell and built assets through the service worker

Runtime data stays in browser-managed storage on the current device:

- **Cache Storage** retains downloaded ArcGIS runtime/map resources used by the interactive snapshot approach.
- **IndexedDB** retains interactive map definitions/feature snapshots plus offline video packages, popup assets, and temporary capture frames.
- The app requests persistent storage, but browsers may still evict data when storage pressure is high if persistence is denied.

There is no server sync or cross-device restore flow in this prototype.

## Approach details

### 1) Interactive offline snapshot

Use the default route to preview a public WebMap, run a compatibility preflight, and save a bounded offline snapshot for interactive use.

Current implementation boundaries:

- current extent plus a 25% buffer and two higher-detail tile levels
- public WebMaps and public layer resources only
- unsupported layers are listed before a user can approve a degraded snapshot
- no editing or synchronization

### 2) Offline video package

Use `?approach=offline-video` to capture final views in playback order. Each saved package includes:

- a WebM video rendered in-browser
- retained popup metadata/content plus downloaded popup assets when available
- browser-routable playback using `video-package=<saved-package-id>`
- export as **two files**: `<name>.webm` and `<name>.json`

There is no hard-coded view limit, but larger view counts and larger map viewports increase duration and temporary working storage. The UI warns once estimated temporary working storage reaches roughly **250 MB**, and capture can still fail earlier or later depending on browser quota/performance.

### Popup retention and fallback behavior

Popup HTML is sanitized before playback/export. The retained HTML path removes unsafe or unsupported elements/attributes such as scripts, forms, inline styles, iframes, SVG, audio/video, and interactive inputs. When popup DOM/media cannot be safely retained or fetched, the package stores warning metadata and may include a static fallback image for offline playback instead.

Attachments and popup media are saved only when they can be fetched during capture; missing assets are shown as unavailable offline.

## Browser support

Desktop Chrome and Edge are the primary targets for both approaches.

The offline video workflow specifically depends on browser WebCodecs support plus in-browser WebM muxing through `mediabunny` (`video/webm`, preferring VP9 then VP8). In practice, creating saved video packages currently requires Chrome or Edge-class support. Other browsers may load the app but fail to encode or reliably play generated video packages.

## Prototype boundaries

- Public WebMaps and public layer resources only
- Browser-local storage only; no hosted package service or sync
- Interactive offline capture is bounded to the current map area
- Offline video playback is a saved, non-interactive capture of ordered final views
- Export is download-only; there is no import workflow for the exported WebM/JSON files

This is a custom browser snapshot/video prototype, not an officially supported ArcGIS offline WebMap or map-area workflow. Content licensing and attribution requirements still apply to retained basemaps, popup media, and exported files.
