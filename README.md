# Offline ArcGIS WebMap Viewer Prototype

A React + Vite PWA for public ArcGIS WebMaps with two browser-local offline approaches:

- **Interactive offline snapshot** — self-hosted ArcGIS Maps SDK assets plus bounded map/resource capture for later offline browsing.
- **Offline video package** — ordered final views rendered into a saved MP4 or WebM video with popup metadata/assets for offline playback.

## Run locally

```bash
npm install
npm run dev
```

## Deploy to GitHub Pages

The `Deploy GitHub Pages` workflow builds and deploys the site whenever a commit is pushed. It can
also be started manually from the repository Actions page.

Before the first deployment, set the repository's **Settings → Pages → Build and deployment**
source to **GitHub Actions**. The workflow automatically builds with the repository subpath, so the
application shell, service worker, PWA shortcuts, and ArcGIS runtime assets work from
`https://<owner>.github.io/<repository>/`.

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

Package metadata stays in browser-managed storage on the current device. Payloads can use either:

- **Browser storage** — Cache Storage retains downloaded ArcGIS map resources, while IndexedDB retains interactive map definitions/features, video packages, popup assets, and temporary frames.
- **A selected folder** — desktop Chrome/Edge users can choose a folder that receives map resources, feature chunks, popup assets, temporary frames, and final videos directly. IndexedDB retains only package metadata and small indexes needed to reopen those files.
- The app requests persistent storage, but browsers may still evict data when storage pressure is high if persistence is denied.

Folder handles are remembered when the browser permits it. A browser may require the user to reconnect the folder after a restart or permission change. Existing browser-backed packages remain readable after a folder is selected.

The production service worker precaches the application shell, lazy application chunks, required ArcGIS localization/icons, geometry assets, and ArcGIS worker chunks. After the initial online load and package download, saved routes can be hard-refreshed offline.

There is no server sync or cross-device restore flow in this prototype. Moving or deleting a selected package folder outside the application makes its package unavailable.

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

- an H.264/MP4 video when supported, with VP8/VP9 WebM as a fallback
- retained popup metadata/content plus downloaded popup assets when available
- browser-routable playback using `video-package=<saved-package-id>`
- export as **two files**: `<name>.mp4` or `<name>.webm`, plus `<name>.json`

Transitions are captured at **24 FPS** with damped elastic pan motion and eased logarithmic zoom. Final-view hold frames reuse the already captured final image, which avoids repeatedly rendering identical map states.

There is no hard-coded view limit, but larger view counts and larger map viewports increase duration and temporary working storage. The UI warns once estimated temporary working storage reaches roughly **250 MB**, and capture can still fail earlier or later depending on browser quota/performance.

### Popup retention and fallback behavior

Popup HTML is sanitized before playback/export. The retained HTML path removes unsafe or unsupported elements/attributes such as scripts, forms, inline styles, iframes, SVG, audio/video, and interactive inputs. When popup DOM/media cannot be safely retained or fetched, the package stores warning metadata and may include a static fallback image for offline playback instead.

Attachments and popup media are saved only when they can be fetched during capture; missing assets are shown as unavailable offline.

## Browser support

Desktop Chrome and Edge are the primary targets for both approaches.

The offline video workflow specifically depends on browser WebCodecs support plus in-browser muxing through `mediabunny`. It prefers H.264/MP4 because that combination has the broadest reliable playback in Chromium, then falls back to VP8/VP9 WebM. In practice, creating saved video packages currently requires Chrome or Edge-class support. Other browsers may load the app but fail to encode or reliably play generated video packages.

The File System Access API used by **Choose download folder** is also a desktop Chrome/Edge feature. Unsupported browsers continue to use browser storage.

## Offline verification

Use the production service worker when checking offline behavior:

```bash
npm run build
npm run preview
```

1. Open a public WebMap while online and create a package.
2. Open the saved package once, switch the browser network context offline, and hard-refresh its saved URL.
3. For interactive snapshots, pan and zoom inside the downloaded coverage and confirm features/tiles remain visible.
4. For videos, play the full capture and use every saved-view seek button.
5. Repeat with **Choose download folder** and confirm the package files are created below `offline-arcgis-packages/`.

Representative public test items used by this prototype are:

- `f2e9b762544945f390ca4ac3671cfa72` — small feature layer with a vector basemap
- `816a9036e6b9415587d67d04257107f9` — raster tile WebMap
- `c50de463235e4161b206d000587af18b` — vector tile style/glyph resources
- `3d355e34cbd3405dbb3f031286f7b39b` — unsupported imagery-layer preflight

## Prototype boundaries

- Public WebMaps and public layer resources only
- Browser-local storage only; no hosted package service or sync
- Interactive offline capture is bounded to the current map area
- Offline video playback is a saved, non-interactive capture of ordered final views
- Export is download-only; there is no import workflow for the exported WebM/JSON files

This is a custom browser snapshot/video prototype, not an officially supported ArcGIS offline WebMap or map-area workflow. Content licensing and attribution requirements still apply to retained basemaps, popup media, and exported files.
