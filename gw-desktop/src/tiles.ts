import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import type { HeaderEntry } from './settings';

export type TileMode = 'online' | 'cache' | 'off';

/** Mirrors `MapSettings` in src-tauri/src/tiles.rs. */
export interface MapSettings {
  mode: TileMode;
  urlTemplate: string;
  attribution: string;
  headers: HeaderEntry[];
  verifySsl: boolean;
  proxy: string;
}

export interface MapSettingsView {
  settings: MapSettings;
  revision: number;
}

export const getMapSettings = () => invoke<MapSettingsView>('get_map_settings');
export const saveMapSettings = (settings: MapSettings) => invoke<MapSettingsView>('save_map_settings', { settings });
export const clearTileCache = () => invoke<void>('clear_tile_cache');

declare global {
  // Read by Graphic Walker's built-in maps (its hard-coded OSM URL is rewritten to this at build time).
  var __gwTileUrl: string | undefined;
}

/**
 * Leaflet URL template pointing at the local tile proxy (`tiles:` protocol handled in Rust).
 * `revision` busts the webview cache when the tile source changes. Empty string = no basemap.
 */
export function tileUrlFor(view: MapSettingsView): string {
  if (view.settings.mode === 'off') return '';
  return `${convertFileSrc('', 'tiles')}{z}/{x}/{y}?v=${view.revision}`;
}

export function applyToGraphicWalker(view: MapSettingsView) {
  globalThis.__gwTileUrl = tileUrlFor(view);
}
