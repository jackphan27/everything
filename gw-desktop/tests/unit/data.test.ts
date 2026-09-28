import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeText, inferFields, parseJsonText } from '../../src/data';

const fixture = (...p: string[]) => path.resolve(import.meta.dirname, '../fixtures', ...p);
const typeOf = (rows: Record<string, unknown>[], fid: string) => {
  const f = inferFields(rows).find((x) => x.fid === fid)!;
  return `${f.semanticType}/${f.analyticType}`;
};

describe('inferFields', () => {
  const rows = [
    { Sales: 10.5, Region: 'East', 'Order Date': '2024-05-17', id_kec: 3201001, latitude: -6.2, lng: 106.8, zip: 12345, when: '2024-05-17T10:00:00Z' },
    { Sales: 3, Region: 'West', 'Order Date': '2024/06/01', id_kec: 3201002, latitude: -6.3, lng: 106.9, zip: 12346, when: '2024-05-18 11:30' },
  ];
  it('numbers are measures', () => expect(typeOf(rows, 'Sales')).toBe('quantitative/measure'));
  it('text is a nominal dimension', () => expect(typeOf(rows, 'Region')).toBe('nominal/dimension'));
  it('ISO and slash dates are temporal', () => {
    expect(typeOf(rows, 'Order Date')).toBe('temporal/dimension');
    expect(typeOf(rows, 'when')).toBe('temporal/dimension');
  });
  it('numeric codes (id_*, zip) are dimensions, not summed', () => {
    expect(typeOf(rows, 'id_kec')).toBe('nominal/dimension');
    expect(typeOf(rows, 'zip')).toBe('nominal/dimension');
  });
  it('coordinates are quantitative dimensions (one map point each)', () => {
    expect(typeOf(rows, 'latitude')).toBe('quantitative/dimension');
    expect(typeOf(rows, 'lng')).toBe('quantitative/dimension');
  });
  it('ignores empty values when inferring', () => {
    expect(typeOf([{ v: null }, { v: '' }, { v: 4 }], 'v')).toBe('quantitative/measure');
  });
  it('mixed columns fall back to nominal', () => {
    expect(typeOf([{ v: 1 }, { v: 'n/a' }], 'v')).toBe('nominal/dimension');
  });
});

describe('decodeText', () => {
  const utf16le = (s: string, bom: boolean) => {
    const b = Buffer.from(s, 'utf16le');
    return new Uint8Array(bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), b]) : b);
  };
  it('strips a UTF-8 BOM', () => expect(decodeText(new Uint8Array(Buffer.from('﻿{"a":1}')))).toBe('{"a":1}'));
  it('decodes UTF-16 LE with and without BOM', () => {
    expect(decodeText(utf16le('{"a":"é"}', true))).toBe('{"a":"é"}');
    expect(decodeText(utf16le('{"a":"é"}', false))).toBe('{"a":"é"}');
  });
  it('decodes UTF-16 BE with BOM', () => {
    const le = Buffer.from('{}', 'utf16le');
    const be = Buffer.alloc(le.length);
    for (let i = 0; i < le.length; i += 2) { be[i] = le[i + 1]; be[i + 1] = le[i]; }
    expect(decodeText(new Uint8Array(Buffer.concat([Buffer.from([0xfe, 0xff]), be])))).toBe('{}');
  });
});

describe('parseJsonText', () => {
  it('pretty-printed GeoJSON is one document, not JSON Lines', () => {
    const ds = parseJsonText('pretty.geojson', fs.readFileSync(fixture('json', 'pretty.geojson'), 'utf8'));
    expect(ds.geo?.kind).toBe('polygon');
    expect(ds.rows).toHaveLength(12);
    expect(ds.rows[0]).toHaveProperty('_fid', 0);
    expect(ds.rows[0]).toHaveProperty('centroid_longitude');
  });
  it('GeoJSONSeq (RS-separated features)', () => {
    const ds = parseJsonText('seq.geojson', fs.readFileSync(fixture('json', 'seq.geojson'), 'utf8'));
    expect(ds.geo?.kind).toBe('polygon');
    expect(ds.rows).toHaveLength(12);
  });
  it('JSON Lines tables', () => {
    const ds = parseJsonText('t.jsonl', '{"a":1,"b":2}\n{"a":3,"b":4}\n');
    expect(ds.geo).toBeUndefined();
    expect(ds.rows).toEqual([{ a: 1, b: 2 }, { a: 3, b: 4 }]);
  });
  it('arrays and { data: [...] } wrappers', () => {
    expect(parseJsonText('a.json', '[{"x":1}]').rows).toEqual([{ x: 1 }]);
    expect(parseJsonText('w.json', '{"data":[{"x":1},{"x":2}]}').rows).toHaveLength(2);
  });
  it('point features get longitude/latitude columns', () => {
    const ds = parseJsonText('p.geojson', JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { name: 'A' }, geometry: { type: 'Point', coordinates: [106.8, -6.2] } }],
    }));
    expect(ds.geo?.kind).toBe('point');
    expect(ds.rows[0]).toMatchObject({ name: 'A', longitude: 106.8, latitude: -6.2 });
  });
  it('broken JSON gives a readable error with a snippet', () => {
    expect(() => parseJsonText('bad.json', '{\n  "type": "FeatureCollection",,\n}')).toThrow(/Invalid JSON: .*Near: …/);
  });
  it('rejects JSON that is not a table or GeoJSON', () => {
    expect(() => parseJsonText('n.json', '42')).toThrow(/must be GeoJSON or an array/);
  });
});
