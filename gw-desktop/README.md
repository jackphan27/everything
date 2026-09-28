# Graphic Walker Desktop (Windows 11)

[Graphic Walker](https://github.com/Kanaries/graphic-walker) packaged as a small, local-only Windows app with Tauri 2.

## Why Tauri
| Concern | Choice |
|---|---|
| File size | Uses the WebView2 runtime built into Windows 11 (no bundled Chromium). Portable `gw-desktop.exe` is ~6.3 MB (including a built-in offline world basemap), including the whole UI. |
| Startup | App shell is a 248 KB chunk and paints in about 100 ms. Graphic Walker and Vega (4.3 MB) load lazily and are prefetched while the app is idle. |
| Resources | One WebView2 process group, not Electron's bundled Chromium. CSV parsing and chart computation run in web workers. Release build uses LTO, `opt-level=s` and stripped symbols. |
| Privacy | The CSP blocks all network access from the UI. The CDN URLs Graphic Walker hard-codes (leaflet CSS, logo, OSM tiles) are rewritten at build time. WebView2 background networking is disabled. Only the Rust backend makes network calls: AI requests (field names and types only, never rows) and basemap tiles (tile coordinates only). |

## AI settings (toolbar → *AI settings*)
- OpenAI-compatible (`/chat/completions`) or Anthropic (`/messages`) format; base URL; model.
- API key is stored in **Windows Credential Manager**. You can choose which header carries the key and its prefix (e.g. `Authorization: Bearer …` or `api-key: …`).
- **Custom headers** (any number; they can override the defaults).
- **Verify SSL** toggle (off = accept self-signed or mismatched certs). The Windows certificate store is used when it's on.
- Optional proxy, timeout, temperature and max tokens. *Test connection* checks the settings before you save them.

The model answers with a Graphic Walker "terse spec", which is converted into a chart with `normalize()`.

## Maps
- **Inputs:** GeoJSON (`.geojson`/`.json`), shapefiles (a `.zip`, or select `.shp` + `.dbf` + `.prj` (+ `.cpg`) together; reprojected from the `.prj` to WGS84), and any table with latitude/longitude columns. Several files can be loaded at once.
- **Map layers view:** one layer per dataset (polygons, lines, points), with show/hide, reorder (top of the list draws on top), zoom to layer, opacity, size and outline. Colour can be a single colour, a field (quantile classes for numbers, categories for text), or a value **joined from another table** by key, e.g. `mean(wa_poor_quality_rate)` from a CSV joined onto kecamatan polygons by `id_kec`. Hover shows the attributes. Features are drawn on canvas, one pane per layer.
- **Explore view (Graphic Walker):** a polygon dataset can be used directly as a choropleth (Geo ID = `_fid`). Every loaded polygon file is also offered as boundary data for choropleths of other tables. Point and polygon rows get lon/lat (or centroid) columns for POI maps.
- **Basemap (default: built-in, fully offline):** Natural Earth land, coastlines and country borders are embedded in the exe (1:50m worldwide, 1:10m around Southeast Asia at zoom ≥ 6) and drawn into tiles by the backend (`src-tauri/src/basemap.rs`). No internet needed. Both the Map layers view and Graphic Walker's maps use it.
- **Optional online tiles:** any XYZ tile server (OSM or an internal one) with custom headers, SSL-verify toggle and proxy, cached on disk. If a tile can't be fetched, the built-in basemap is served instead, and the server is skipped for 60 s. *Cached online tiles only* never touches the network. Use *Test tile server* in the ⚙ dialog to see why a server fails (HTTP status, TLS error, …).
- Regenerate the embedded data with `npm i --no-save world-atlas@2 topojson-client@3 && node scripts/build-basemap.mjs`. Natural Earth is public domain.

## Build
- **CI:** every push runs `.github/workflows/gw-desktop.yml`: tests on Linux, then the Windows build on `windows-latest`. Download the `gw-desktop-windows` artifact (portable exe and NSIS installer).
- **Locally on Windows:** `npm ci && npx tauri build` (needs Node 22 and Rust).
- **Cross-compile from Linux:** `cargo install cargo-xwin && rustup target add x86_64-pc-windows-msvc && npx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --no-bundle`
- **Dev:** `npx tauri dev`

## Tests
| Command | What it checks |
|---|---|
| `npm run typecheck` | TypeScript, including the tests |
| `npm test` | Unit tests (vitest): type inference, JSON/GeoJSON parsing, joins, AI reply handling |
| `npm run test:e2e` | Builds the UI and runs Playwright against it with a mocked backend: CSV + AI charts, map layers, GeoJSON variants, offline basemap. Every test also fails on page errors or any request leaving the machine. |
| `cd src-tauri && cargo test` | Rust: AI request building (against a local test server), tile fetching, basemap rendering. On Linux this needs `libwebkit2gtk-4.1-dev`. |

Supported inputs: CSV / TSV / JSON / JSONL / GeoJSON / shapefile (drag-and-drop or *Add data…*).
