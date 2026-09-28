import { describe, expect, it } from 'vitest';
import { buildJoin, makeScale, NO_DATA, normKey, type JoinConfig } from '../../src/mapLayers';
import type { Dataset } from '../../src/data';
import { collectionKind, detectLatLon, representativePoint, rowsToPoints } from '../../src/geo';

describe('normKey', () => {
  it('matches numeric keys written as text, numbers or padded text', () => {
    expect(normKey('3201010')).toBe(normKey(3201010));
    expect(normKey(' 3201010 ')).toBe('3201010');
    expect(normKey('3201010.0')).toBe('3201010');
  });
  it('text keys are case- and space-insensitive', () => expect(normKey(' Kec Bogor ')).toBe(normKey('kec bogor')));
  it('null and undefined are empty (never matched)', () => {
    expect(normKey(null)).toBe('');
    expect(normKey(undefined)).toBe('');
  });
});

describe('buildJoin', () => {
  const table = {
    id: 't', name: 't', fields: [],
    rows: [
      { k: '1', v: 2 }, { k: 1, v: 4 }, { k: '2', v: 10 }, { k: '2', v: null }, { k: null, v: 99 }, { k: '3', v: 'x' },
    ],
  } as Dataset;
  const join = (agg: JoinConfig['agg']) => buildJoin({ datasetId: 't', layerKey: 'k', dataKey: 'k', valueField: 'v', agg }, table);
  it('mean / sum / min / max over numeric values, per key', () => {
    expect(join('mean').get('1')).toBe(3);
    expect(join('sum').get('1')).toBe(6);
    expect(join('min').get('1')).toBe(2);
    expect(join('max').get('1')).toBe(4);
  });
  it('count counts rows, including empty values', () => expect(join('count').get('2')).toBe(2));
  it('first keeps text values', () => expect(join('first').get('3')).toBe('x'));
  it('rows without a key are skipped; keys without numbers have no mean', () => {
    expect([...join('count').keys()].sort()).toEqual(['1', '2', '3']);
    expect(join('mean').has('3')).toBe(false);
  });
});

describe('makeScale', () => {
  it('numbers get up to 5 quantile classes, missing values grey', () => {
    const s = makeScale([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, null]);
    expect(s.legend).toHaveLength(5);
    expect(s.color(1)).toBe(s.legend[0].color);
    expect(s.color(10)).toBe(s.legend[4].color);
    expect(s.color(null)).toBe(NO_DATA);
  });
  it('text gets categories, the rest grouped as "other"', () => {
    const s = makeScale([...'abcdefghijkl'].map((c) => c));
    expect(s.legend.at(-1)?.label).toMatch(/^other \(\d+\)$/);
    expect(s.color('a')).not.toBe(NO_DATA);
  });
});

describe('geo helpers', () => {
  it('representative point is the bbox centre for polygons', () => {
    expect(representativePoint({ type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 2], [0, 2], [0, 0]]] })).toEqual([2, 1]);
  });
  it('mixed collections take the dominant kind (polygon > line > point)', () => {
    expect(collectionKind({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } },
        { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
      ],
    })).toBe('line');
  });
  it('detects lat/lon columns and skips invalid coordinates', () => {
    const ll = detectLatLon([
      { fid: 'lintang', semanticType: 'quantitative', analyticType: 'dimension' },
      { fid: 'bujur', semanticType: 'quantitative', analyticType: 'dimension' },
    ]);
    expect(ll).toEqual({ lat: 'lintang', lon: 'bujur' });
    const fc = rowsToPoints([{ lintang: -6, bujur: 106 }, { lintang: 95, bujur: 106 }, { lintang: null, bujur: 'x' }], 'lintang', 'bujur');
    expect(fc.features).toHaveLength(1);
  });
});
