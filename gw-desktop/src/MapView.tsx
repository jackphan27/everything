import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Feature } from 'geojson';
import type { Dataset } from './data';
import { FEATURE_ID } from './geo';
import {
  addLayersFor, buildJoin, JOINED, makeScale, mappable, normKey, NO_DATA,
  type Agg, type ColorScale, type LayerConfig,
} from './mapLayers';
import type { MapSettingsView, TileMode } from './tiles';
import { attributionFor, tileUrlFor } from './tiles';

interface Props {
  datasets: Dataset[];
  layers: LayerConfig[];
  onLayersChange: (layers: LayerConfig[]) => void;
  tiles: MapSettingsView | null;
  onTileModeChange: (mode: TileMode) => void;
  onOpenBasemapSettings: () => void;
}

interface Resolved {
  cfg: LayerConfig;
  ds: Dataset;
  kind: 'polygon' | 'line' | 'point';
  features: Feature[];
  valueOf: (f: Feature) => unknown;
  scale: ColorScale | null;
  joinStats?: { matched: number; total: number };
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function tooltipHtml(r: Resolved, f: Feature): string {
  const props = Object.entries(f.properties ?? {}).filter(([k]) => k !== FEATURE_ID).slice(0, 10);
  const lines = props.map(([k, v]) => `<b>${escapeHtml(k)}</b>: ${escapeHtml(String(v ?? ''))}`);
  if (r.cfg.colorBy === JOINED && r.cfg.join) {
    const v = r.valueOf(f);
    lines.unshift(`<b>${escapeHtml(`${r.cfg.join.agg}(${r.cfg.join.valueField})`)}</b>: ${v === undefined ? '<i>no match</i>' : escapeHtml(String(v))}`);
  }
  return `<div class="map-tip"><div class="map-tip-title">${escapeHtml(r.ds.name)}</div>${lines.join('<br>')}</div>`;
}

function resolve(cfg: LayerConfig, datasets: Dataset[]): Resolved | null {
  const ds = datasets.find((d) => d.id === cfg.datasetId);
  const m = ds && mappable(ds);
  if (!ds || !m) return null;
  const features = m.features.features;
  let valueOf: (f: Feature) => unknown = () => undefined;
  let joinStats: Resolved['joinStats'];
  if (cfg.colorBy === JOINED && cfg.join) {
    const j = cfg.join;
    const table = datasets.find((d) => d.id === j.datasetId);
    if (table && j.layerKey && j.dataKey && j.valueField) {
      const lookup = buildJoin(j, table);
      valueOf = (f) => lookup.get(normKey(f.properties?.[j.layerKey]));
      joinStats = { matched: features.filter((f) => valueOf(f) !== undefined).length, total: features.length };
    }
  } else if (cfg.colorBy) {
    valueOf = (f) => f.properties?.[cfg.colorBy];
  }
  const scale = cfg.colorBy ? makeScale(features.map(valueOf)) : null;
  return { cfg, ds, kind: m.kind, features, valueOf, scale, joinStats };
}

export default function MapView({ datasets, layers, onLayersChange, tiles, onTileModeChange, onOpenBasemapSettings }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const fitted = useRef(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const resolved = useMemo(
    () => layers.map((l) => resolve(l, datasets)).filter((r): r is Resolved => r !== null),
    [layers, datasets],
  );

  // Create the map once.
  useEffect(() => {
    if (!el.current) return;
    const m = L.map(el.current, { preferCanvas: true, worldCopyJump: true }).setView([0, 110], 4);
    map.current = m;
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(el.current);
    return () => { ro.disconnect(); m.remove(); map.current = null; };
  }, []);

  // Basemap through the local tile proxy.
  const tileUrl = tiles ? tileUrlFor(tiles) : '';
  const attribution = tiles ? attributionFor(tiles) : '';
  useEffect(() => {
    const m = map.current;
    if (!m || !tileUrl) return;
    const layer = L.tileLayer(tileUrl, { maxZoom: 19, attribution: escapeHtml(attribution) }).addTo(m);
    return () => { layer.remove(); };
  }, [tileUrl, attribution]);

  // Overlay layers. Each gets its own pane + canvas renderer so stacking order is exact
  // (index 0 in the list is drawn on top) and thousands of features stay cheap to draw.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const added: L.Layer[] = [];
    const n = resolved.length;
    resolved.forEach((r, i) => {
      if (!r.cfg.visible) return;
      const paneName = `overlay-${i}`;
      const pane = m.getPane(paneName) ?? m.createPane(paneName);
      pane.style.zIndex = String(400 + (n - i) * 2);
      const renderer = L.canvas({ pane: paneName, padding: 0.3 });
      const fill = (f: Feature) => (r.scale ? r.scale.color(r.valueOf(f)) : r.cfg.color);
      const layer = L.geoJSON({ type: 'FeatureCollection', features: r.features } as GeoJSON.FeatureCollection, {
        pane: paneName,
        style: (f) => {
          const c = f ? fill(f) : r.cfg.color;
          return r.kind === 'line'
            ? { renderer, color: c, weight: r.cfg.strokeWidth, opacity: r.cfg.opacity }
            : { renderer, color: r.scale ? '#ffffff' : c, weight: r.cfg.strokeWidth, opacity: 0.9, fillColor: c, fillOpacity: r.cfg.opacity };
        },
        pointToLayer: (f, latlng) => {
          const c = fill(f);
          return L.circleMarker(latlng, {
            renderer, pane: paneName, radius: r.cfg.radius, color: '#ffffff', weight: 0.8, fillColor: c, fillOpacity: r.cfg.opacity,
          });
        },
        onEachFeature: (f, lyr) => lyr.bindTooltip(() => tooltipHtml(r, f), { sticky: true }),
      });
      layer.addTo(m);
      added.push(layer, renderer);
    });
    return () => { for (const l of added) l.remove(); };
  }, [resolved]);

  const zoomTo = (rs: Resolved[]) => {
    const m = map.current;
    if (!m) return;
    const b = L.latLngBounds([]);
    for (const r of rs) if (r.features.length) b.extend(L.geoJSON({ type: 'FeatureCollection', features: r.features } as GeoJSON.FeatureCollection).getBounds());
    if (b.isValid()) m.fitBounds(b, { padding: [24, 24], maxZoom: 14 });
  };

  useEffect(() => {
    if (!fitted.current && resolved.length) { fitted.current = true; zoomTo(resolved); }
  }, [resolved]);

  const update = (i: number, patch: Partial<LayerConfig>) =>
    onLayersChange(layers.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...layers];
    const [l] = next.splice(i, 1);
    next.splice(Math.max(0, Math.min(next.length, i + d)), 0, l);
    onLayersChange(next);
  };

  const available = datasets.filter((d) => mappable(d) && !layers.some((l) => l.datasetId === d.id));

  return (
    <div className="mapview">
      <aside className="layers">
        <div className="layers-head">
          <strong>Layers</strong>
          <span className="spacer" />
          <button onClick={() => zoomTo(resolved.filter((r) => r.cfg.visible))} title="Zoom to all visible layers">Zoom to all</button>
        </div>
        <label className="basemap">Basemap
          <span className="pair">
            <select value={tiles?.settings.mode ?? 'builtin'} onChange={(e) => onTileModeChange(e.target.value as TileMode)}>
              <option value="builtin">Built-in offline map</option>
              <option value="online">Online tiles (cached, offline fallback)</option>
              <option value="cache">Cached online tiles only</option>
              <option value="off">None</option>
            </select>
            <button onClick={onOpenBasemapSettings} title="Online tile server, SSL, proxy, cache">⚙</button>
          </span>
        </label>

        {available.length > 0 && (
          <select value="" onChange={(e) => onLayersChange(addLayersFor(layers, datasets.filter((d) => d.id === e.target.value)))}>
            <option value="">+ Add layer…</option>
            {available.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        )}
        {resolved.length === 0 && (
          <p className="hint">Open a GeoJSON / shapefile (polygons, lines, points) or a table with latitude &amp; longitude columns.</p>
        )}

        {resolved.map((r, i) => {
          const fields = r.ds.fields.map((f) => f.fid).filter((f) => f !== FEATURE_ID);
          const others = datasets.filter((d) => d.id !== r.ds.id);
          const joinTable = others.find((d) => d.id === r.cfg.join?.datasetId);
          const open = expanded === r.cfg.datasetId;
          return (
            <div className="layer" key={r.cfg.datasetId}>
              <div className="layer-row">
                <input type="checkbox" checked={r.cfg.visible} onChange={(e) => update(i, { visible: e.target.checked })} title="Show / hide" />
                <span className="swatch" style={{ background: r.scale ? r.scale.legend[r.scale.legend.length - 1]?.color : r.cfg.color }} />
                <button className="layer-name" onClick={() => setExpanded(open ? null : r.cfg.datasetId)} title={r.ds.name}>
                  {r.ds.name}
                </button>
                <span className="badge">{r.kind} · {r.features.length.toLocaleString()}</span>
                <button className="icon" onClick={() => move(i, -1)} disabled={i === 0} title="Move up (draw on top)">↑</button>
                <button className="icon" onClick={() => move(i, 1)} disabled={i === resolved.length - 1} title="Move down">↓</button>
                <button className="icon" onClick={() => zoomTo([r])} title="Zoom to layer">⤢</button>
                <button className="icon" onClick={() => onLayersChange(layers.filter((_, j) => j !== i))} title="Remove from map">✕</button>
              </div>

              {open && (
                <div className="layer-body">
                  <label>Colour by
                    <select value={r.cfg.colorBy} onChange={(e) => {
                      const colorBy = e.target.value;
                      const join = colorBy === JOINED && !r.cfg.join && others[0]
                        ? { datasetId: others[0].id, layerKey: '', dataKey: '', valueField: '', agg: 'mean' as Agg }
                        : r.cfg.join;
                      update(i, { colorBy, join });
                    }}>
                      <option value="">Single colour</option>
                      {fields.map((f) => <option key={f} value={f}>{f}</option>)}
                      {others.length > 0 && <option value={JOINED}>Joined from another table…</option>}
                    </select>
                  </label>
                  {!r.cfg.colorBy && (
                    <label>Colour <input type="color" value={r.cfg.color} onChange={(e) => update(i, { color: e.target.value })} /></label>
                  )}

                  {r.cfg.colorBy === JOINED && r.cfg.join && (
                    <div className="join">
                      <label>Table
                        <select value={r.cfg.join.datasetId} onChange={(e) => update(i, { join: { ...r.cfg.join!, datasetId: e.target.value, dataKey: '', valueField: '' } })}>
                          {others.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                        </select>
                      </label>
                      <label>Layer key
                        <select value={r.cfg.join.layerKey} onChange={(e) => update(i, { join: { ...r.cfg.join!, layerKey: e.target.value } })}>
                          <option value="">—</option>
                          {fields.map((f) => <option key={f} value={f}>{f}</option>)}
                        </select>
                      </label>
                      <label>Table key
                        <select value={r.cfg.join.dataKey} onChange={(e) => update(i, { join: { ...r.cfg.join!, dataKey: e.target.value } })}>
                          <option value="">—</option>
                          {joinTable?.fields.map((f) => <option key={f.fid} value={f.fid}>{f.fid}</option>)}
                        </select>
                      </label>
                      <label>Value
                        <span className="pair">
                          <select value={r.cfg.join.agg} onChange={(e) => update(i, { join: { ...r.cfg.join!, agg: e.target.value as Agg } })}>
                            {(['mean', 'sum', 'min', 'max', 'count', 'first'] as Agg[]).map((a) => <option key={a}>{a}</option>)}
                          </select>
                          <select value={r.cfg.join.valueField} onChange={(e) => update(i, { join: { ...r.cfg.join!, valueField: e.target.value } })}>
                            <option value="">—</option>
                            {joinTable?.fields.map((f) => <option key={f.fid} value={f.fid}>{f.fid}</option>)}
                          </select>
                        </span>
                      </label>
                      {r.joinStats && (
                        <span className={r.joinStats.matched ? 'hint' : 'hint err'}>
                          Matched {r.joinStats.matched.toLocaleString()} of {r.joinStats.total.toLocaleString()} features
                        </span>
                      )}
                    </div>
                  )}

                  <label>{r.kind === 'line' ? 'Opacity' : 'Fill opacity'} {Math.round(r.cfg.opacity * 100)}%
                    <input type="range" min={0.05} max={1} step={0.05} value={r.cfg.opacity} onChange={(e) => update(i, { opacity: Number(e.target.value) })} />
                  </label>
                  {r.kind === 'point' ? (
                    <label>Point size {r.cfg.radius}px
                      <input type="range" min={1} max={20} value={r.cfg.radius} onChange={(e) => update(i, { radius: Number(e.target.value) })} />
                    </label>
                  ) : (
                    <label>{r.kind === 'line' ? 'Line width' : 'Outline'} {r.cfg.strokeWidth}px
                      <input type="range" min={0} max={6} step={0.5} value={r.cfg.strokeWidth} onChange={(e) => update(i, { strokeWidth: Number(e.target.value) })} />
                    </label>
                  )}
                </div>
              )}

              {r.scale && (
                <ul className="legend">
                  {r.scale.legend.map((e) => <li key={e.label}><span className="swatch" style={{ background: e.color }} />{e.label}</li>)}
                  {r.cfg.colorBy === JOINED && <li><span className="swatch" style={{ background: NO_DATA }} />no data</li>}
                </ul>
              )}
            </div>
          );
        })}
      </aside>
      <div className="map" ref={el} />
    </div>
  );
}
