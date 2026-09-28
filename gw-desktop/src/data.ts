import Papa from 'papaparse';
import type { FeatureCollection } from 'geojson';
import type { IMutField, IRow } from '@kanaries/graphic-walker';
import { featuresToRows, isFeatureCollectionLike, LAT_NAMES, LON_NAMES, toFeatureCollection, type GeomKind } from './geo';

export interface GeoData {
  kind: GeomKind;
  /** Features with `_fid` in their properties (matches the `_fid` column in rows). */
  collection: FeatureCollection;
}

export interface Dataset {
  id: string;
  name: string;
  rows: IRow[];
  fields: IMutField[];
  geo?: GeoData;
}

const SAMPLE_SIZE = 2000;
const DIMENSION_NAME = /(^|[_\s-])(id|code|kode|zip|zipcode|postcode|phone|key)$|^_fid$|^id_/i;
const DATE_LIKE = /^\d{4}[-/]\d{1,2}([-/]\d{1,2})?([ T]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$|^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/;

let nextId = 1;
const newId = () => `ds${nextId++}`;

/** Infer Graphic Walker field metadata from a sample of the rows. */
export function inferFields(rows: IRow[]): IMutField[] {
  const keys = new Set<string>();
  for (const r of rows.slice(0, 50)) for (const k of Object.keys(r)) keys.add(k);

  const step = Math.max(1, Math.floor(rows.length / SAMPLE_SIZE));
  return [...keys].map((key): IMutField => {
    let numeric = 0, dates = 0, seen = 0;
    for (let i = 0; i < rows.length && seen < SAMPLE_SIZE; i += step) {
      const v = rows[i][key];
      if (v === null || v === undefined || v === '') continue;
      seen++;
      if (typeof v === 'number' && Number.isFinite(v)) numeric++;
      else if (v instanceof Date || (typeof v === 'string' && DATE_LIKE.test(v.trim()))) dates++;
    }
    const base = { fid: key, name: key };
    if (seen > 0 && dates === seen) return { ...base, semanticType: 'temporal', analyticType: 'dimension' };
    // Coordinates are numeric but must group rows (one map point each), never be summed.
    if (seen > 0 && numeric === seen && (LAT_NAMES.test(key) || LON_NAMES.test(key))) {
      return { ...base, semanticType: 'quantitative', analyticType: 'dimension' };
    }
    if (seen > 0 && numeric === seen && !DIMENSION_NAME.test(key)) {
      return { ...base, semanticType: 'quantitative', analyticType: 'measure' };
    }
    return { ...base, semanticType: 'nominal', analyticType: 'dimension' };
  });
}

function parseDelimited(file: File): Promise<IRow[]> {
  return new Promise((resolve, reject) => {
    Papa.parse<IRow>(file, {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: 'greedy',
      // Parse off the UI thread so large files never freeze the window.
      worker: true,
      complete: (res) => resolve(res.data),
      error: (err) => reject(err),
    });
  });
}

function tableDataset(name: string, rows: IRow[]): Dataset {
  if (!rows.length) throw new Error(`${name} contains no rows.`);
  return { id: newId(), name, rows, fields: inferFields(rows) };
}

function geoDataset(name: string, fc: FeatureCollection): Dataset {
  const { rows, collection, kind } = featuresToRows(fc);
  if (!rows.length) throw new Error(`${name} contains no features with geometry.`);
  return { id: newId(), name, rows, fields: inferFields(rows), geo: { kind, collection } };
}

async function parseJsonFile(file: File): Promise<Dataset> {
  const text = await file.text();
  const trimmed = text.trimStart();
  // JSON Lines / NDJSON
  if (!trimmed.startsWith('[') && trimmed.includes('\n{')) {
    const rows = trimmed.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    return tableDataset(file.name, rows);
  }
  const json = JSON.parse(text);
  if (isFeatureCollectionLike(json)) return geoDataset(file.name, toFeatureCollection(json));
  if (Array.isArray(json)) return tableDataset(file.name, json);
  // Common wrappers: { data: [...] } / { rows: [...] } / { records: [...] }
  for (const k of ['data', 'rows', 'records', 'items']) if (Array.isArray(json?.[k])) return tableDataset(file.name, json[k]);
  throw new Error('JSON must be GeoJSON or an array of objects (or { "data": [...] }).');
}

async function parseShapefile(name: string, input: Parameters<typeof import('shpjs').default>[0]): Promise<Dataset[]> {
  // shpjs (+ proj4 for reprojection from the .prj) is only loaded when a shapefile is opened.
  const { default: shp } = await import('shpjs');
  const result = await shp(input);
  const layers = Array.isArray(result) ? result : [result];
  return layers.map((fc) => geoDataset(layers.length > 1 && fc.fileName ? `${name} · ${fc.fileName}` : name, fc));
}

const ext = (f: File) => f.name.split('.').pop()?.toLowerCase() ?? '';
const stem = (f: File) => f.name.replace(/\.[^.]+$/, '');

/**
 * Load everything the user dropped/picked. Shapefile parts (.shp/.dbf/.prj/.cpg/.shx) that
 * share a base name are combined into one layer; a .zip may hold one or more shapefiles.
 */
export async function loadFiles(files: File[]): Promise<{ datasets: Dataset[]; errors: string[] }> {
  const datasets: Dataset[] = [];
  const errors: string[] = [];
  const shpParts = new Map<string, Record<string, File>>();

  const tasks: Promise<void>[] = [];
  const run = (name: string, fn: () => Promise<Dataset | Dataset[]>) =>
    tasks.push(fn().then(
      (d) => { datasets.push(...(Array.isArray(d) ? d : [d])); },
      (e) => { errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); },
    ));

  for (const f of files) {
    const e = ext(f);
    if (['shp', 'dbf', 'prj', 'cpg', 'shx', 'sbn', 'sbx', 'xml'].includes(e)) {
      const parts = shpParts.get(stem(f)) ?? {};
      parts[e] = f;
      shpParts.set(stem(f), parts);
    } else if (e === 'zip') {
      run(f.name, async () => parseShapefile(stem(f), await f.arrayBuffer()));
    } else if (['json', 'geojson', 'jsonl', 'ndjson'].includes(e)) {
      run(f.name, () => parseJsonFile(f));
    } else {
      run(f.name, async () => tableDataset(f.name, await parseDelimited(f)));
    }
  }
  for (const [name, parts] of shpParts) {
    if (!parts.shp) {
      if (parts.dbf) run(`${name}.dbf`, () => Promise.reject(new Error('select the .shp file together with the .dbf (and .prj)')));
      continue;
    }
    run(`${name}.shp`, async () =>
      parseShapefile(name, {
        shp: await parts.shp.arrayBuffer(),
        dbf: parts.dbf && (await parts.dbf.arrayBuffer()),
        prj: parts.prj && (await parts.prj.text()),
        cpg: parts.cpg && (await parts.cpg.text()),
      }),
    );
  }
  await Promise.all(tasks);
  return { datasets, errors };
}
