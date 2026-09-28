import Papa from 'papaparse';
import type { IMutField, IRow } from '@kanaries/graphic-walker';

export interface Dataset {
  name: string;
  rows: IRow[];
  fields: IMutField[];
}

const SAMPLE_SIZE = 2000;
const DIMENSION_NAME = /(^|[_\s-])(id|code|zip|zipcode|postcode|phone|key)$/i;
const DATE_LIKE = /^\d{4}[-/]\d{1,2}([-/]\d{1,2})?([ T]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$|^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/;

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

async function parseJson(file: File): Promise<IRow[]> {
  const text = await file.text();
  const trimmed = text.trimStart();
  // JSON Lines / NDJSON
  if (!trimmed.startsWith('[') && trimmed.includes('\n{')) {
    return trimmed.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  }
  const json = JSON.parse(text);
  if (Array.isArray(json)) return json;
  // Common wrappers: { data: [...] } / { rows: [...] } / { records: [...] }
  for (const k of ['data', 'rows', 'records', 'items']) if (Array.isArray(json?.[k])) return json[k];
  throw new Error('JSON must be an array of objects (or { "data": [...] }).');
}

export async function loadFile(file: File): Promise<Dataset> {
  const ext = file.name.split('.').pop()?.toLowerCase();
  const rows = ext === 'json' || ext === 'jsonl' || ext === 'ndjson' ? await parseJson(file) : await parseDelimited(file);
  if (!rows.length) throw new Error('The file contains no rows.');
  return { name: file.name, rows, fields: inferFields(rows) };
}
