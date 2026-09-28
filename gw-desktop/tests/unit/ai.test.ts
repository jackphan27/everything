// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { IViewField } from '@kanaries/graphic-walker';
import { extractJson, toChart } from '../../src/ai';

const metas: IViewField[] = [
  { fid: 'Region', name: 'Region', semanticType: 'nominal', analyticType: 'dimension' },
  { fid: 'Sales', name: 'Sales', semanticType: 'quantitative', analyticType: 'measure' },
  // Graphic Walker's built-in fields must be ignored (they caused duplicate-fid errors).
  { fid: 'gw_count_fid', name: 'Row count', semanticType: 'quantitative', analyticType: 'measure' },
  { fid: 'gw_mea_key_fid', name: 'Measure names', semanticType: 'nominal', analyticType: 'dimension' },
] as IViewField[];

describe('AI reply handling', () => {
  it('extracts JSON from code fences and surrounding prose', () => {
    expect(extractJson('Sure!\n```json\n{"mark":"bar"}\n```\nDone')).toEqual({ mark: 'bar' });
    expect(extractJson('here: {"a":{"b":1}} ok')).toEqual({ a: { b: 1 } });
  });
  it('fails clearly when there is no JSON', () => expect(() => extractJson('no idea')).toThrow(/did not return JSON/));
  it('turns a terse spec into a chart without duplicate built-in fields', () => {
    const chart = toChart('{"mark":"bar","x":"Region","y":"sum(Sales)"}', metas);
    expect(chart.config.geoms).toEqual(['bar']);
    expect(chart.encodings.columns.map((f) => f.fid)).toEqual(['Region']);
    expect(chart.encodings.rows.map((f) => f.fid)).toEqual(['Sales']);
    const fids = chart.encodings.dimensions.concat(chart.encodings.measures).map((f) => f.fid);
    expect(new Set(fids).size).toBe(fids.length);
  });
  it('accepts SQL-style count(*)', () => {
    const chart = toChart('{"mark":"bar","x":"Region","y":"count(*)"}', metas);
    expect(chart.encodings.rows).toHaveLength(1);
  });
});
