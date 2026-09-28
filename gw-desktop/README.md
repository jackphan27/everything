# Graphic Walker Desktop (Windows 11)

[Graphic Walker](https://github.com/Kanaries/graphic-walker) packaged as a small, local-only Windows app with Tauri 2.

## Why Tauri
| Concern | Choice |
|---|---|
| File size | Uses the WebView2 runtime built into Windows 11 (no bundled Chromium). Portable `gw-desktop.exe` is ~4.6 MB, including the whole UI. |
| Startup | App shell is a 248 KB chunk and paints in about 100 ms. Graphic Walker and Vega (4.3 MB) load lazily and are prefetched while the app is idle. |
| Resources | One WebView2 process group, not Electron's bundled Chromium. CSV parsing and chart computation run in web workers. Release build uses LTO, `opt-level=s` and stripped symbols. |
| Privacy | The CSP blocks all network access from the UI. The two CDN URLs Graphic Walker hard-codes (leaflet CSS, logo) are rewritten at build time. WebView2 background networking is disabled. Only the Rust backend can reach the AI endpoint, and it sends field names and types only, never rows. Online map tiles won't load. |

## AI settings (toolbar → *AI settings*)
- OpenAI-compatible (`/chat/completions`) or Anthropic (`/messages`) format; base URL; model.
- API key is stored in **Windows Credential Manager**. You can choose which header carries the key and its prefix (e.g. `Authorization: Bearer …` or `api-key: …`).
- **Custom headers** (any number; they can override the defaults).
- **Verify SSL** toggle (off = accept self-signed or mismatched certs). The Windows certificate store is used when it's on.
- Optional proxy, timeout, temperature and max tokens. *Test connection* checks the settings before you save them.

The model answers with a Graphic Walker "terse spec", which is converted into a chart with `normalize()`.

## Build
- **CI:** every push runs `.github/workflows/gw-desktop-windows.yml` on `windows-latest`. Download the `gw-desktop-windows` artifact (portable exe and NSIS installer).
- **Locally on Windows:** `npm ci && npx tauri build` (needs Node 22 and Rust).
- **Cross-compile from Linux:** `cargo install cargo-xwin && rustup target add x86_64-pc-windows-msvc && npx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --no-bundle`
- **Dev:** `npx tauri dev`

Supported inputs: CSV / TSV / JSON / JSONL (drag-and-drop or *Open data…*).
