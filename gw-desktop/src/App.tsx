import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IDarkMode, IGeoDataItem } from '@kanaries/graphic-walker';
import { loadFiles, type Dataset } from './data';
import { addLayersFor, type LayerConfig } from './mapLayers';
import { getSettings } from './settings';
import { applyToGraphicWalker, getMapSettings, saveMapSettings, type MapSettingsView, type TileMode } from './tiles';

// Split the heavy bundles out of the startup path.
const Walker = lazy(() => import('./Walker'));
const MapView = lazy(() => import('./MapView'));
const SettingsDialog = lazy(() => import('./SettingsDialog'));
const BasemapDialog = lazy(() => import('./BasemapDialog'));
// Start fetching/parsing the Walker chunk right after first paint, while the user picks a file.
const prefetchWalker = () => void import('./Walker');

const ACCEPT = '.csv,.tsv,.txt,.json,.jsonl,.ndjson,.geojson,.zip,.shp,.dbf,.prj,.cpg,.shx';

type View = 'explore' | 'map';

export default function App() {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<View>('explore');
  const [layers, setLayers] = useState<LayerConfig[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showBasemap, setShowBasemap] = useState(false);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [tiles, setTiles] = useState<MapSettingsView | null>(null);
  const [appearance, setAppearance] = useState<IDarkMode>('media');
  const inputRef = useRef<HTMLInputElement>(null);

  const applyTiles = useCallback((v: MapSettingsView) => { applyToGraphicWalker(v); setTiles(v); }, []);

  useEffect(() => {
    getSettings().then((v) => setAiEnabled(v.settings.enabled)).catch(() => {});
    getMapSettings().then(applyTiles).catch(() => {});
    const id = requestIdleCallback(prefetchWalker, { timeout: 1500 });
    return () => cancelIdleCallback(id);
  }, [applyTiles]);

  const open = useCallback(async (files?: FileList | File[] | null) => {
    if (!files || !files.length) return;
    setLoading(true);
    const res = await loadFiles([...files]);
    setLoading(false);
    setErrors(res.errors);
    if (!res.datasets.length) return;
    setDatasets((prev) => [...prev, ...res.datasets]);
    setLayers((prev) => addLayersFor(prev, res.datasets));
    setActiveId(res.datasets[res.datasets.length - 1].id);
  }, []);

  const remove = (id: string) => {
    const rest = datasets.filter((d) => d.id !== id);
    setDatasets(rest);
    setLayers((ls) => ls.filter((l) => l.datasetId !== id).map((l) => (l.join?.datasetId === id ? { ...l, colorBy: '', join: undefined } : l)));
    if (activeId === id) setActiveId(rest.at(-1)?.id ?? null);
  };

  // Polygon layers become selectable boundary files in Graphic Walker's choropleth settings.
  const geoList = useMemo<IGeoDataItem[]>(
    () => datasets.filter((d) => d.geo && d.geo.kind !== 'point').map((d) => ({
      type: 'GeoJSON',
      name: d.name,
      url: URL.createObjectURL(new Blob([JSON.stringify(d.geo!.collection)], { type: 'application/geo+json' })),
    })),
    [datasets],
  );
  useEffect(() => () => geoList.forEach((g) => URL.revokeObjectURL(g.url)), [geoList]);

  const setTileMode = (mode: TileMode) => {
    if (tiles) saveMapSettings({ ...tiles.settings, mode }).then(applyTiles).catch((e) => setErrors([String(e)]));
  };

  const active = datasets.find((d) => d.id === activeId) ?? null;

  return (
    <div
      className="app"
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={(e) => { e.preventDefault(); setDragging(false); open(e.dataTransfer.files); }}
    >
      <header className="toolbar">
        <button className="primary" onClick={() => inputRef.current?.click()} disabled={loading}>
          {loading ? 'Loading…' : 'Add data…'}
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          onChange={(e) => { open(e.target.files); e.target.value = ''; }}
        />
        {datasets.length > 0 && (
          <>
            <select value={activeId ?? ''} onChange={(e) => setActiveId(e.target.value)} title="Dataset shown in Explore">
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} · {d.rows.length.toLocaleString()} {d.geo ? `${d.geo.kind} features` : 'rows'}
                </option>
              ))}
            </select>
            {active && <button onClick={() => remove(active.id)} title="Close this dataset">✕</button>}
            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={view === 'explore'} className={view === 'explore' ? 'on' : ''} onClick={() => setView('explore')}>Explore</button>
              <button role="tab" aria-selected={view === 'map'} className={view === 'map' ? 'on' : ''} onClick={() => setView('map')}>Map layers</button>
            </div>
          </>
        )}
        <span className="spacer" />
        <select value={appearance} onChange={(e) => setAppearance(e.target.value as IDarkMode)} title="Theme">
          <option value="media">System theme</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
        <button onClick={() => setShowSettings(true)}>AI settings{aiEnabled ? ' ●' : ''}</button>
      </header>

      {errors.length > 0 && (
        <div className="banner err">
          {errors.map((e) => <div key={e}>{e}</div>)}
          <button className="link" onClick={() => setErrors([])}>dismiss</button>
        </div>
      )}

      <main className="content">
        {!active ? (
          <div className={`empty drop ${dragging ? 'over' : ''}`} onClick={() => inputRef.current?.click()}>
            <strong>Drop CSV, JSON, GeoJSON or shapefiles here</strong>
            <span>Shapefiles: a .zip, or select the .shp + .dbf + .prj files together. You can add several files as map layers.</span>
            <span>Files are read locally and never uploaded.</span>
          </div>
        ) : view === 'map' ? (
          <Suspense fallback={<div className="empty">Loading map…</div>}>
            <MapView
              datasets={datasets}
              layers={layers}
              onLayersChange={setLayers}
              tiles={tiles}
              onTileModeChange={setTileMode}
              onOpenBasemapSettings={() => setShowBasemap(true)}
            />
          </Suspense>
        ) : (
          <Suspense fallback={<div className="empty">Starting visual editor…</div>}>
            <Walker dataset={active} geoList={geoList} appearance={appearance} aiEnabled={aiEnabled} tileRevision={tiles?.revision ?? 0} />
          </Suspense>
        )}
      </main>

      {showSettings && (
        <Suspense fallback={null}>
          <SettingsDialog
            onClose={(saved) => {
              setShowSettings(false);
              if (saved) setAiEnabled(saved.enabled);
            }}
          />
        </Suspense>
      )}
      {showBasemap && tiles && (
        <Suspense fallback={null}>
          <BasemapDialog
            initial={tiles.settings}
            onClose={(saved) => {
              setShowBasemap(false);
              if (saved) applyTiles(saved);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
