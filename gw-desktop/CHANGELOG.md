# Changelog

All notable changes to Graphic Walker Desktop. Versions follow the roadmap in [PLAN.md](PLAN.md).

## 0.3.0 — Baseline release
### Added
- Built-in **offline basemap**: Natural Earth land, coastlines and country borders embedded in the exe (1:50m worldwide, 1:10m around Southeast Asia from zoom 6), rendered to tiles in Rust (tiny-skia). Default basemap; also the fallback when online tiles fail.
- Tile modes: built-in, online (fetch + disk cache + fallback, 60 s offline backoff), cached-only, off.
- Robust JSON/GeoJSON reading: UTF-8 BOM, UTF-16 LE/BE (with or without BOM), pretty-printed GeoJSON, JSONL and GeoJSONSeq; clearer error messages with a snippet.
- Product plan (`PLAN.md`) and task list (`TASK.md`).
- Automated tests: vitest unit tests, Playwright e2e tests (mocked backend, no external requests allowed), Rust tests, and a real-exe smoke test on Windows (tauri-driver) covering CSV load, an AI chart over HTTPS with SSL verification off, and the built-in basemap. CI runs all of them.

### Fixed
- Pretty-printed GeoJSON was misread as JSON Lines ("Expected property name or '}' at position 1").
- Map stayed blank because the CSP blocked the OSM tile server.
- Leaving the Map layers view while the map was zooming threw an error (Leaflet timer after the map was removed).
- The UI failed to start in WebKit-based webviews (no `requestIdleCallback`).
- WebView2 privacy switches (no background networking, pings or component updates) are now applied by the main window at runtime and can be combined with switches from `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`.

## 0.2.0 — Geo data and map layers
### Added
- GeoJSON and shapefile import (`.zip`, or loose `.shp`/`.dbf`/`.prj`/`.cpg` parts), reprojected to WGS84.
- **Map layers** view: polygon, line and point layers with show/hide, reorder, zoom to layer, opacity, size, outline, tooltips and legend.
- Colour by field (quantile classes or categories) or by a value **joined from another table** (mean, sum, min, max, count, first) with match statistics.
- Polygon datasets usable as choropleth boundaries in Graphic Walker; lon/lat or centroid columns added to geo rows.
- Tile proxy in the Rust backend (`tiles:` protocol) with custom headers, SSL-verify toggle, proxy and disk cache; *Test tile server* and *Clear tile cache*.

## 0.1.0 — First desktop build
### Added
- Tauri 2 app packaging Graphic Walker 0.5.2 for Windows 11 (WebView2, NSIS installer, portable exe ~6 MB).
- Lazy-loaded Graphic Walker; small app shell for fast startup; size-tuned release profile.
- CSV/TSV/JSON/JSONL import with type inference (lat/lon treated as dimensions).
- AI chart generation through a backend proxy: OpenAI-compatible or Anthropic format, custom headers, SSL-verify toggle, proxy, API key in Windows Credential Manager. Only field names and types are sent, never rows.
- Strict CSP: the webview has no network access; Graphic Walker's CDN URLs are rewritten at build time.
- Windows CI workflow and cross-compile instructions (cargo-xwin).
