# Task list

> Plan and rationale: [PLAN.md](PLAN.md). Work top to bottom. Tick `[x]` when *Done when* is met,
> and add `(YYYY-MM-DD, commit)`. Each task should be small enough for one focused session.

## Done: v0.1–v0.3 foundation
- [x] Tauri 2 app with Graphic Walker, lazy-loaded, size-tuned release build (2026-09-28, ffb4351..)
- [x] AI proxy: custom headers, SSL-verify toggle, key in Windows Credential Manager, OpenAI/Anthropic formats
- [x] Strict CSP; Graphic Walker CDN URLs rewritten at build time (no network from the webview)
- [x] CSV/TSV/JSON import with type inference; lat/lon as dimensions
- [x] GeoJSON and shapefile import (zip or loose parts, reprojection); robust JSON (BOM, UTF-16, GeoJSONSeq)
- [x] Multi-layer Map view: polygon/line/point layers, colour by field, join from another table
- [x] Tile proxy with disk cache; built-in offline basemap (Natural Earth, rendered in Rust); fallback when offline
- [x] Windows cross-compile (cargo-xwin) and CI workflow file

## v0.3: Baseline release
- [ ] **T0.3.1** Version bump to 0.3.0 in package.json, Cargo.toml, tauri.conf.json; add CHANGELOG.md.
  *Done when:* all three show 0.3.0; CHANGELOG lists v0.1–v0.3 features.
- [ ] **T0.3.2** Move the Playwright e2e scripts (mocked backend) into `tests/e2e` with fixtures in `tests/fixtures`; `npm run test:e2e`.
  *Done when:* the CSV/AI, map-layers, GeoJSON-variants and basemap tests pass locally from a clean checkout.
- [ ] **T0.3.3** Add `vitest` with first unit tests (type inference, JSON parsing, join key normalisation).
  *Done when:* `npm test` passes with at least 10 tests.
- [ ] **T0.3.4** Rust tests in the crate (`tiles`, `basemap`, AI header building); `cargo test` works on Linux (feature-gate Windows-only bits if needed).
  *Done when:* `cargo test` passes.
- [ ] **T0.3.5** CI: run typecheck, unit, e2e and cargo tests plus the Windows build on every push; upload the installer artifact.
  *Done when:* the workflow is green on the branch and the artifact downloads.
- [ ] **T0.3.6** Real-exe smoke test on the Windows runner (tauri-driver): app starts, loads a CSV, a chart renders, the basemap tile endpoint returns a PNG.
  *Done when:* the CI job passes.
- [ ] **T0.3.7** Open PR to `main` with the user checklist; after approval, merge and tag `v0.3.0`.
  *Done when:* merged and tagged.

## v0.4: Workbook + version control ★ priority 1
- [ ] **T0.4.1** Workbook schema v1: TypeScript types + JSON Schema (`docs/workbook-schema.md`) for sheets, data sources, field metadata, map layers.
  *Done when:* schema validation unit tests pass for valid and invalid samples.
- [ ] **T0.4.2** Workbook store in the UI: one state object for the whole workbook; sheet tabs (chart sheet, map sheet) with create/rename/duplicate/delete/reorder.
  *Done when:* e2e test creates 3 sheets, renames one, reorders, deletes one.
- [ ] **T0.4.3** Per-sheet chart state: capture and restore Graphic Walker charts when switching sheets (export/import spec).
  *Done when:* e2e test builds charts on 2 sheets, switches back and forth, charts are identical.
- [ ] **T0.4.4** Add DuckDB (duckdb-rs, bundled) to the backend with a `db_version` smoke command; record the size increase.
  *Done when:* command returns the version on Windows; size noted in CHANGELOG.
- [ ] **T0.4.5** Data storage: datasets written as Parquet (zstd) named by SHA-256 of content; read back into the UI.
  *Done when:* round-trip test: rows, types and nulls identical for CSV and geo datasets.
- [ ] **T0.4.6** Excel import (`calamine`): sheet picker for multi-sheet files, header-row detection, dates as dates.
  *Done when:* fixture `.xlsx` with 2 sheets, dates and merged header imports correctly (unit + e2e).
- [ ] **T0.4.7** `.gwd` container read/write in Rust: manifest, workbook.json, data/, atomic write (temp + rename + fsync).
  *Done when:* round-trip test passes; kill-during-write test leaves the previous file intact.
- [ ] **T0.4.8** File commands: New / Open / Save / Save As / Recent files (tauri dialog plugin); window title with name and unsaved marker; prompt on close with unsaved changes.
  *Done when:* e2e covers save → new → open → same sheets and charts.
- [ ] **T0.4.9** Autosave to a recovery folder and crash-recovery prompt on start.
  *Done when:* test simulates a crash (no clean exit) → next start offers recovery → restored state matches.
- [ ] **T0.4.10** History store: revisions of workbook.json inside `.gwd` (content-addressed, data deduplicated); automatic snapshot policy (on save and after N minutes of edits).
  *Done when:* unit tests: 3 edits produce 3 revisions, identical data stored once.
- [ ] **T0.4.11** Named versions: "Save version…" with name and note.
  *Done when:* appears in history with note; survives save/open.
- [ ] **T0.4.12** Timeline panel UI: list of revisions and named versions with time, note and thumbnail.
  *Done when:* e2e: 5 revisions visible in order; named ones highlighted.
- [ ] **T0.4.13** Thumbnails: capture a small PNG per sheet at snapshot time.
  *Done when:* thumbnails stored in history and shown in the timeline.
- [ ] **T0.4.14** Diff engine: structured diff of two revisions → readable change list (sheet added/removed/renamed, chart type, fields per channel, filters, data source changes).
  *Done when:* at least 15 fixture-based unit tests produce the expected wording.
- [ ] **T0.4.15** Compare view: pick two versions → change list plus before/after thumbnails.
  *Done when:* e2e compares two versions and shows the expected changes.
- [ ] **T0.4.16** Restore: whole workbook, single sheet, or "copy as new workbook" from any version.
  *Done when:* restored charts render identically to the original (screenshot comparison).
- [ ] **T0.4.17** Data versions: replacing or refreshing a data file keeps the old data; the timeline shows "+rows / columns changed".
  *Done when:* old version still shows old numbers after data replacement.
- [ ] **T0.4.18** Share options: "Export latest only" vs "Export with history".
  *Done when:* latest-only file has no history/ and opens correctly.
- [ ] **T0.4.19** History cleanup settings (keep named versions; thin out autosnapshots older than N days).
  *Done when:* unit test on cleanup rules.
- [ ] **T0.4.20** Scale test: 1,000 revisions + 5M-row dataset: file size, open time, timeline load time within limits; add `tests/fixtures/workbooks/v0.4`.
  *Done when:* benchmark recorded; limits enforced in CI.
- [ ] **T0.4.21** Release v0.4.0: CHANGELOG, version bump, PR, installer, user checklist.

## v0.5: Dashboards + PDF ★ priority 2
- [ ] **T0.5.1** Dashboard sheet type with a grid layout (drag, resize, snap); fixed size vs fit-to-window.
- [ ] **T0.5.2** Chart tiles: render a chart sheet in a tile (GW renderer), linked to the source sheet.
- [ ] **T0.5.3** Map tiles: render a map sheet in a tile.
- [ ] **T0.5.4** Text, image and KPI tiles (KPI: measure, aggregation, comparison, sparkline).
- [ ] **T0.5.5** Global filter controls (list, range, date range) applied to every tile on the dashboard using that data source.
- [ ] **T0.5.6** Click-to-filter actions between tiles, plus highlight.
- [ ] **T0.5.7** Parameters (number, text, list) usable in filters and calculations.
- [ ] **T0.5.8** PDF export via WebView2 PrintToPdf: page size (A4/A3/Letter), orientation, margins, footer (workbook, version name, date), one or more dashboards/sheets.
- [ ] **T0.5.9** PNG export of a sheet or dashboard.
- [ ] **T0.5.10** Dashboards included in version-control diff and restore.
- [ ] **T0.5.11** Tests: dashboard screenshot comparisons; filter reaches every tile; PDF page count and searchable text.
- [ ] **T0.5.12** Release v0.5.0.

## v0.6: Speed ★ priority 3
- [ ] **T0.6.1** Benchmark harness and generated datasets (1M, 5M rows); record the current baseline.
- [ ] **T0.6.2** Translator: GW query → SQL (filter, transform, aggregate, raw, fold, bin, sort, limit).
- [ ] **T0.6.3** Correctness tests comparing DuckDB results with GW's own computation (hundreds of generated queries).
- [ ] **T0.6.4** Switch GW to backend computation (DuckDB) for datasets above a threshold; rows no longer loaded into the webview.
- [ ] **T0.6.5** Query result cache and cancellation of outdated queries.
- [ ] **T0.6.6** Field statistics and profiling through DuckDB.
- [ ] **T0.6.7** GPU drawing for large point layers in the Map view; automatic binning for dense scatter plots.
- [ ] **T0.6.8** Performance limits in CI (p95 interaction, memory, startup, size).
- [ ] **T0.6.9** Release v0.6.0.

## v0.7: Street map + POI
- [ ] **T0.7.1** Spike: build an OSM street pack for one small country (Singapore) with Planetiler → PMTiles; record size and build time.
- [ ] **T0.7.2** Backend PMTiles reader served via the `tiles:` protocol (range reads, gzip).
- [ ] **T0.7.3** MapLibre GL in the Map view with a street style (light/dark), existing layers drawn on top.
- [ ] **T0.7.4** APAC overview pack (major roads and cities, low zoom) bundled with the installer; size limit agreed.
- [ ] **T0.7.5** CI pipeline: build country packs (e.g. Indonesia) as release assets.
- [ ] **T0.7.6** Pack manager UI: import a pack file, list and remove installed packs, coverage shown on the map.
- [ ] **T0.7.7** Spike: street basemap for Graphic Walker's own maps (raster fallback).
- [ ] **T0.7.8** POI extraction per pack (categories: hospital, clinic, pharmacy, school, university, police, fire station, transport, market, bank, worship, …) to Parquet.
- [ ] **T0.7.9** POI layer in the Map view: browse, search, filter by category.
- [ ] **T0.7.10** Analysis: nearest facility per row (category, name, distance) as new columns.
  *Done when:* 100k points × country hospitals in under 5 s; results verified against brute force.
- [ ] **T0.7.11** Analysis: count of facilities within a radius.
- [ ] **T0.7.12** Spike: road-network travel distance/time (routing) feasibility and size.
- [ ] **T0.7.13** OSM attribution on every OSM-based map, in PDF too.
- [ ] **T0.7.14** Release v0.7.0.

## v0.8: Data prep
- [ ] **T0.8.1** Data source page: preview grid, column types, rename, hide, aliases, formats.
- [ ] **T0.8.2** Profile panel (nulls, distribution, outliers, duplicates, suspicious types).
- [ ] **T0.8.3** Joins with join check (row counts, key uniqueness, unmatched keys export).
- [ ] **T0.8.4** Unions.
- [ ] **T0.8.5** Cleaning recipe (split, trim, pivot/unpivot, dedupe, replace, fix types), re-applied on refresh.
- [ ] **T0.8.6** Calculated fields: formula language → SQL, autocomplete, live preview.
- [ ] **T0.8.7** Fuzzy key matching helper for joins.
- [ ] **T0.8.8** Release v0.8.0.

## v0.9: Geo+
- [ ] **T0.9.1** Boundary library: import boundaries once, reuse across workbooks.
- [ ] **T0.9.2** Point-in-polygon join.
- [ ] **T0.9.3** Hexbin and heatmap layers.
- [ ] **T0.9.4** Region drill-down hierarchy (e.g. province → district → subdistrict).
- [ ] **T0.9.5** Release v0.9.0.

## v1.0: PostgreSQL + polish
- [ ] **T1.0.1** PostgreSQL extract (DuckDB postgres extension bundled offline), SSL options.
- [ ] **T1.0.2** SSH tunnel.
- [ ] **T1.0.3** Incremental refresh (ID / updated_at column).
- [ ] **T1.0.4** Custom SQL data source.
- [ ] **T1.0.5** Trend lines and forecasting.
- [ ] **T1.0.6** Release v1.0.0.
