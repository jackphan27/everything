import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const LEAFLET_CDN = /"https:\/\/unpkg\.com\/leaflet@[\d.]+\/dist\/leaflet\.css",\s*integrity:\s*"[^"]*",\s*crossOrigin:\s*""/;
const KANARIES_LOGO_CDN = /"https:\/\/imagedelivery\.net\/[^"]+"/;
const OSM_TILES = /"https:\/\/\{s\}\.tile\.openstreetmap\.org\/\{z\}\/\{x\}\/\{y\}\.png"/g;

/**
 * Graphic Walker hard-codes CDN URLs (leaflet.css from unpkg, a logo image, OSM tiles).
 * Rewrite them at build time so the webview never attempts a network request:
 * leaflet.css is bundled locally, the logo falls back to its bundled copy, and map
 * tiles go through the app's local tile proxy (`globalThis.__gwTileUrl`, see src/tiles.ts).
 */
function keepGraphicWalkerOffline(): Plugin {
  return {
    name: 'keep-graphic-walker-offline',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('@kanaries/graphic-walker/dist/')) return null;
      if (!LEAFLET_CDN.test(code) && !KANARIES_LOGO_CDN.test(code) && !code.includes('tile.openstreetmap.org')) return null;
      return {
        code:
          `import __gwLeafletCss from 'leaflet/dist/leaflet.css?url';\n` +
          code
            .replace(LEAFLET_CDN, '__gwLeafletCss')
            .replace(KANARIES_LOGO_CDN, '""')
            .replace(OSM_TILES, '(globalThis.__gwTileUrl ?? "")'),
        map: null,
      };
    },
  };
}

// WebView2 on Windows 11 is evergreen Chromium, so we can ship modern JS
// without legacy transforms/polyfills (smaller bundle, faster parse).
export default defineConfig({
  plugins: [keepGraphicWalkerOffline(), react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: 'chrome120',
    minify: 'esbuild',
    cssMinify: true,
    sourcemap: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 8000,
  },
  esbuild: {
    legalComments: 'none',
    drop: process.env.TAURI_ENV_DEBUG ? [] : ['debugger'],
  },
});
