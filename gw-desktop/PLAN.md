# Graphic Walker Desktop: Product Plan

> Source of truth for *what* we build and *why*. Progress is tracked in [TASK.md](TASK.md).
> After any context reset, read this file and TASK.md before doing anything.

## 1. Vision
A local-first, Tableau-class analytics desktop app for Windows 11, built on Graphic Walker.
It should beat Tableau on **version control, dashboards, and speed on millions of rows**,
and on geospatial work in Asia-Pacific (street maps, POIs, "nearest hospital" analysis).
All data stays on the user's PC.

## 2. Decisions (agreed with the user)
| Topic | Decision |
|---|---|
| Platform | Windows 11. An installer (NSIS/MSI) is fine; a portable exe is optional. |
| Size | Larger is acceptable (DuckDB etc.), but every version reports its size. |
| Languages | Any (Rust backend, TypeScript UI, Java/other tools in CI are fine). |
| UI language | English only. |
| Data sources, first | CSV, Excel, GeoJSON, shapefile. |
| Data sources, later | PostgreSQL over SSH (lowest priority). |
| Live vs extract | Extracts only. |
| Data volume | 100k to several million rows; must not lag (Tableau's pain point). |
| Sharing | 1) Workbook file (`.gwd`), 2) PDF. No HTML export. |
| Encryption | Not required (fully local). |
| AI | Trusted, user-configured endpoint only (custom headers, SSL-verify toggle). The model sees field names and types, never rows. |
| Maps | Asia-Pacific. **Street map** (OSM) wanted, plus POIs (hospitals, schools, …) for analyses like nearest facility. Boundaries (province/kecamatan…) are imported by the user, not bundled. |
| Priority order | **Version control → Dashboards → Speed**, then street map/POI, data prep, geo+, PostgreSQL. |

## 3. Principles
1. **Local-first:** the webview has no network access (CSP). Only the Rust backend talks to the network (AI endpoint, optional tile server).
2. **Small steps:** every task is small, tested and ticked in TASK.md. Every version is one PR plus an installer, and the user accepts it before the next version starts.
3. **Nothing breaks silently:** automated tests for each feature; each release opens the previous release's files; performance and size limits in CI.
4. **Fast by design:** heavy work runs in the backend (DuckDB) or in workers, never on the UI thread.

## 4. Architecture
**Current (v0.3):** Tauri 2 (Rust) + WebView2. React UI, Graphic Walker (charts), Leaflet (Map view).
Data is parsed in the webview and held in memory. The backend has an AI proxy (`ai.rs`), a tile proxy
and cache (`tiles.rs`), and a built-in offline basemap renderer (`basemap.rs`, Natural Earth, tiny-skia).

**Target (v1.0):**
```
UI (React) ── Graphic Walker (authoring) ── Dashboards ── Map view (MapLibre GL)
     │ invoke / custom protocols (no network)
Rust backend
  ├─ Workbook store (.gwd: manifest + workbook.json + Parquet data + history)
  ├─ DuckDB engine (extracts, GW queries → SQL, profiling, spatial analysis)
  ├─ Tile server (built-in basemap, PMTiles street packs, online cache)
  ├─ POI store (OSM POIs per country pack, Parquet)
  ├─ AI proxy (custom headers, SSL toggle)
  └─ PDF export (WebView2 PrintToPdf)
```

### Workbook file `.gwd` (designed in v0.4, stable from then on)
A ZIP container with:
- `manifest.json`: format version, app version
- `workbook.json`: sheets, dashboards, data sources, field metadata, map layers
- `data/<sha256>.parquet`: content-addressed data, stored only once
- `history/`: revisions (workbook.json snapshots plus data references), named versions, thumbnails

Saves are atomic (write a temp file, then rename).

## 5. Roadmap (one version = one PR + installer + user acceptance)
| Version | Theme | Scope | Exit criteria |
|---|---|---|---|
| v0.1–v0.3 | Foundation ✔ | Tauri app, GW, AI proxy, maps, GeoJSON/shapefile, offline basemap | Built and pushed |
| **v0.3** | Baseline release | Tests into the repo, CI green, real-exe smoke test, merge to main | User accepts, tag v0.3.0 |
| **v0.4** | Workbook + version control | Sheets, `.gwd` save/open, Excel import, DuckDB storage, autosave/recovery, timeline, named versions, diff, restore, data versions | Save → open is identical; restore reproduces charts exactly; kill-during-save is safe |
| **v0.5** | Dashboards + PDF | Layout, chart/map/text/KPI tiles, global filters, click-to-filter, parameters, PDF/PNG export | 4 sheets + map filter together; PDF has sharp charts and searchable text |
| **v0.6** | Speed | DuckDB runs GW queries, cache, cancel, GPU drawing and binning, benchmarks in CI | 5M rows: interactions under 300 ms (p95), no UI freeze |
| **v0.7** | Street map + POI | OSM street basemap (PMTiles packs per country, MapLibre), APAC overview, POI store, nearest-facility and within-radius analysis | Nearest hospital for 100k points in under 5 s, fully offline |
| **v0.8** | Data prep | Types, rename/hide, profile, join check, unions, cleaning recipe, calculated fields | Join report lists unmatched keys; recipe re-runs on refresh |
| **v0.9** | Geo+ | Boundary library, point-in-polygon join, hexbin/heatmap, drill-down hierarchy | POIs assigned to regions without codes |
| **v1.0** | PostgreSQL + polish | PG extracts, incremental refresh, SSL, SSH tunnel; forecasting and trends | Connects over SSH to a test PG |

## 6. Street map + POI design (v0.7)
- **Format:** vector tiles (OpenMapTiles/Protomaps schema) in **PMTiles** files. The backend serves them through the `tiles:` protocol; the Map view renders them with **MapLibre GL** (GPU, sharp labels).
- **Coverage:** all of Asia-Pacific at street level is tens of GB, so:
  - an *APAC overview* (major roads and cities, low zoom) is bundled with the installer
  - *country street packs* (e.g. Indonesia, Singapore) are built in CI from OSM (Geofabrik + Planetiler) and imported once as files
- **POIs:** extracted from the same OSM data per pack (hospital, clinic, pharmacy, school, university, police, fire station, bus/rail station, airport, market, bank, place of worship, …) and stored as Parquet with category, name and coordinates.
- **Analysis:** nearest facility (straight-line distance first) and counts within a radius, via DuckDB with a spatial index. Results become new columns usable in charts and maps. Road-network travel time (routing) is a research spike.
- **Graphic Walker's own maps:** keep the built-in basemap and add a raster version of the street style if the spike shows it's feasible.
- **Licence:** ODbL attribution shown on every map that uses OSM data.

## 7. Testing strategy
| Layer | How |
|---|---|
| Rust | `cargo test`: workbook I/O, diff, SQL translation, tile rendering, POI queries |
| TypeScript | `vitest`: type inference, workbook schema, layout, formula logic |
| Engine correctness | DuckDB results compared with Graphic Walker's own JS computation on the same queries |
| UI end-to-end | Playwright against the built UI with a mocked backend (`tests/e2e`) |
| Real app | The actual exe driven on a Windows CI runner (tauri-driver / WebDriver) |
| Visual | Reference-image tests for tiles, charts, dashboards, PDF pages |
| Performance | 1M/5M-row benchmarks, startup time, size; CI fails if they get worse |
| Compatibility | `tests/fixtures/workbooks/vX.Y` must open in every later version |
| User acceptance | Each PR has a short checklist to run with real data |

## 8. Working agreement
1. Pick the next unticked task in TASK.md, in order, unless the user says otherwise.
2. Implement → test (as the task's *Done when* says) → commit → tick `[x]` with date and short commit hash.
3. A version ends with: all tasks ticked, CHANGELOG entry, version bump, PR, installer, user checklist.
4. Don't start the next version until the user approves the current PR.
5. If scope changes, update PLAN.md first, then TASK.md.
