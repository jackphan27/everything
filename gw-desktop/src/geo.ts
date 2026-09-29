import type { Feature, FeatureCollection, Geometry, Position } from 'geojson';
import type { IMutField, IRow } from '@kanaries/graphic-walker';

export type GeomKind = 'polygon' | 'line' | 'point';

/** Stable per-feature id, also written into feature properties so Graphic Walker choropleths can join on it. */
export const FEATURE_ID = '_fid';

export function geomKind(g: Geometry | null | undefined): GeomKind | null {
  switch (g?.type) {
    case 'Point': case 'MultiPoint': return 'point';
    case 'LineString': case 'MultiLineString': return 'line';
    case 'Polygon': case 'MultiPolygon': return 'polygon';
    case 'GeometryCollection': return g.geometries.length ? geomKind(g.geometries[0]) : null;
    default: return null;
  }
}

/** Dominant geometry kind of a collection (polygons win over lines over points for mixed files). */
export function collectionKind(fc: FeatureCollection): GeomKind {
  const seen = new Set<GeomKind>();
  for (const f of fc.features) { const k = geomKind(f.geometry); if (k) seen.add(k); }
  return seen.has('polygon') ? 'polygon' : seen.has('line') ? 'line' : 'point';
}

function eachPosition(g: Geometry, cb: (p: Position) => void) {
  switch (g.type) {
    case 'Point': cb(g.coordinates); break;
    case 'MultiPoint': case 'LineString': g.coordinates.forEach(cb); break;
    case 'MultiLineString': case 'Polygon': g.coordinates.forEach((r) => r.forEach(cb)); break;
    case 'MultiPolygon': g.coordinates.forEach((p) => p.forEach((r) => r.forEach(cb))); break;
    case 'GeometryCollection': g.geometries.forEach((c) => eachPosition(c, cb)); break;
  }
}

/** Representative [lon, lat]: the point itself, or the bounding-box centre for lines/polygons. */
export function representativePoint(g: Geometry | null): [number, number] | null {
  if (!g) return null;
  if (g.type === 'Point') return [g.coordinates[0], g.coordinates[1]];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  eachPosition(g, ([x, y]) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  });
  return Number.isFinite(minX) ? [(minX + maxX) / 2, (minY + maxY) / 2] : null;
}

function flattenValue(v: unknown): unknown {
  return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
}

export function isFeatureCollectionLike(json: any): boolean {
  return json && (json.type === 'FeatureCollection' || json.type === 'Feature' || (typeof json.type === 'string' && 'coordinates' in json));
}

export function toFeatureCollection(json: any): FeatureCollection {
  if (json.type === 'FeatureCollection') return json;
  if (json.type === 'Feature') return { type: 'FeatureCollection', features: [json] };
  return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: json, properties: {} }] };
}

/**
 * Turn features into table rows for Graphic Walker: properties + `_fid` + a lon/lat pair
 * (the point itself, or a centroid for polygons/lines) so they also work as a POI map.
 * Returns a copy of the collection whose features carry `_fid` in their properties.
 */
export function featuresToRows(input: FeatureCollection): { rows: IRow[]; collection: FeatureCollection; kind: GeomKind } {
  const kind = collectionKind(input);
  const features = input.features.filter((f) => f.geometry);
  const propKeys = new Set<string>();
  for (const f of features.slice(0, 200)) for (const k of Object.keys(f.properties ?? {})) propKeys.add(k);
  const lonKey = kind === 'point' ? (propKeys.has('longitude') ? 'geom_longitude' : 'longitude') : 'centroid_longitude';
  const latKey = kind === 'point' ? (propKeys.has('latitude') ? 'geom_latitude' : 'latitude') : 'centroid_latitude';

  const rows: IRow[] = [];
  const out: Feature[] = [];
  features.forEach((f, i) => {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(f.properties ?? {})) props[k] = flattenValue(v);
    props[FEATURE_ID] = i;
    const p = representativePoint(f.geometry);
    rows.push({ ...props, [lonKey]: p?.[0] ?? null, [latKey]: p?.[1] ?? null });
    out.push({ type: 'Feature', geometry: f.geometry, properties: props });
  });
  return { rows, collection: { type: 'FeatureCollection', features: out }, kind };
}

export const LAT_NAMES = /^(lat|latitude|lat_dd|y_lat|centroid_latitude|geom_latitude|lintang)$/i;
export const LON_NAMES = /^(lon|lng|long|longitude|lon_dd|x_lon|centroid_longitude|geom_longitude|bujur)$/i;

/** Find a numeric latitude/longitude column pair in a table, if any. */
export function detectLatLon(fields: IMutField[]): { lat: string; lon: string } | null {
  const numeric = fields.filter((f) => f.semanticType === 'quantitative');
  const lat = numeric.find((f) => LAT_NAMES.test(f.fid));
  const lon = numeric.find((f) => LON_NAMES.test(f.fid));
  return lat && lon ? { lat: lat.fid, lon: lon.fid } : null;
}

/** Point features built from table rows with valid coordinates. */
export function rowsToPoints(rows: IRow[], lat: string, lon: string): FeatureCollection {
  const features: Feature[] = [];
  rows.forEach((r, i) => {
    const y = Number(r[lat]), x = Number(r[lon]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(y) > 90 || Math.abs(x) > 180) return;
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [x, y] }, properties: { ...r, [FEATURE_ID]: i } });
  });
  return { type: 'FeatureCollection', features };
}
