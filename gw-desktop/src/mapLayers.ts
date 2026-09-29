import type { FeatureCollection } from 'geojson';
import type { Dataset } from './data';
import { detectLatLon, rowsToPoints, type GeomKind } from './geo';

export type Agg = 'mean' | 'sum' | 'min' | 'max' | 'count' | 'first';

export interface JoinConfig {
  datasetId: string;
  /** Property on the layer's features. */
  layerKey: string;
  /** Column in the joined table. */
  dataKey: string;
  valueField: string;
  agg: Agg;
}

export const JOINED = '__joined__';

export interface LayerConfig {
  datasetId: string;
  visible: boolean;
  color: string;
  /** '' = single colour, a field of the layer, or JOINED for a value joined from another table. */
  colorBy: string;
  join?: JoinConfig;
  opacity: number;
  radius: number;
  strokeWidth: number;
}

export interface Mappable {
  kind: GeomKind;
  features: FeatureCollection;
}

const SINGLE_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2', '#ca8a04'];
const CATEGORICAL = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'];
const SEQUENTIAL = ['#ffffb2', '#fecc5c', '#fd8d3c', '#f03b20', '#bd0026'];
export const NO_DATA = '#9ca3af';

const cache = new WeakMap<Dataset, Mappable | null>();

/** Geometry for a dataset: its own features, or points from lat/lon columns. null = not mappable. */
export function mappable(ds: Dataset): Mappable | null {
  if (cache.has(ds)) return cache.get(ds)!;
  let m: Mappable | null = null;
  if (ds.geo) m = { kind: ds.geo.kind, features: ds.geo.collection };
  else {
    const ll = detectLatLon(ds.fields);
    if (ll) {
      const features = rowsToPoints(ds.rows, ll.lat, ll.lon);
      if (features.features.length) m = { kind: 'point', features };
    }
  }
  cache.set(ds, m);
  return m;
}

export function defaultLayer(ds: Dataset, index: number, kind: GeomKind): LayerConfig {
  return {
    datasetId: ds.id,
    visible: true,
    color: SINGLE_COLORS[index % SINGLE_COLORS.length],
    colorBy: '',
    opacity: kind === 'polygon' ? 0.55 : 0.85,
    radius: 5,
    strokeWidth: kind === 'line' ? 2 : 1,
  };
}

/** New layers: points on top, polygons at the bottom (index 0 = top of the stack). */
export function addLayersFor(layers: LayerConfig[], datasets: Dataset[]): LayerConfig[] {
  const next = [...layers];
  for (const ds of datasets) {
    const m = mappable(ds);
    if (!m || next.some((l) => l.datasetId === ds.id)) continue;
    const layer = defaultLayer(ds, next.length, m.kind);
    if (m.kind === 'point') next.unshift(layer);
    else next.push(layer);
  }
  return next;
}

/** Keys match across "3201010", 3201010 and " 3201010 ". */
export function normKey(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v).trim();
  return s !== '' && !Number.isNaN(Number(s)) ? String(Number(s)) : s.toLowerCase();
}

export function buildJoin(join: JoinConfig, table: Dataset): Map<string, number | string> {
  const groups = new Map<string, unknown[]>();
  for (const r of table.rows) {
    const k = normKey(r[join.dataKey]);
    if (!k) continue;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    g.push(r[join.valueField]);
  }
  const out = new Map<string, number | string>();
  for (const [k, vals] of groups) {
    const nums = vals.map(Number).filter(Number.isFinite);
    switch (join.agg) {
      case 'count': out.set(k, vals.length); break;
      case 'first': if (vals[0] !== null && vals[0] !== undefined) out.set(k, vals[0] as number | string); break;
      case 'sum': if (nums.length) out.set(k, nums.reduce((a, b) => a + b, 0)); break;
      case 'mean': if (nums.length) out.set(k, nums.reduce((a, b) => a + b, 0) / nums.length); break;
      case 'min': if (nums.length) out.set(k, Math.min(...nums)); break;
      case 'max': if (nums.length) out.set(k, Math.max(...nums)); break;
    }
  }
  return out;
}

export interface ColorScale {
  color: (v: unknown) => string;
  legend: { label: string; color: string }[];
}

const fmt = (n: number) => (Math.abs(n) >= 1000 || Number.isInteger(n) ? n.toLocaleString() : n.toPrecision(3));

export function makeScale(values: unknown[]): ColorScale {
  const present = values.filter((v) => v !== null && v !== undefined && v !== '');
  const nums = present.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (present.length && nums.length >= present.length * 0.9) {
    // Quantile classes: robust to skewed rates/counts.
    const sorted = [...nums].sort((a, b) => a - b);
    const breaks = [...new Set([1, 2, 3, 4].map((i) => sorted[Math.floor((i / 5) * (sorted.length - 1))]))];
    const palette = breaks.length + 1 >= SEQUENTIAL.length ? SEQUENTIAL : SEQUENTIAL.slice(SEQUENTIAL.length - breaks.length - 1);
    const classOf = (n: number) => { let i = 0; while (i < breaks.length && n > breaks[i]) i++; return i; };
    const bounds = [sorted[0], ...breaks, sorted[sorted.length - 1]];
    return {
      color: (v) => (typeof v === 'number' && Number.isFinite(v) ? palette[classOf(v)] : NO_DATA),
      legend: palette.map((c, i) => ({ label: `${fmt(bounds[i])} – ${fmt(bounds[i + 1])}`, color: c })),
    };
  }
  const counts = new Map<string, number>();
  for (const v of present) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, CATEGORICAL.length).map(([k]) => k);
  const idx = new Map(top.map((k, i) => [k, i]));
  const legend = top.map((k, i) => ({ label: k, color: CATEGORICAL[i] }));
  if (counts.size > top.length) legend.push({ label: `other (${counts.size - top.length})`, color: NO_DATA });
  return { color: (v) => CATEGORICAL[idx.get(String(v)) ?? -1] ?? NO_DATA, legend };
}
