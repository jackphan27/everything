import fs from 'node:fs';
import { test, expect, expectClean, fixture } from './harness';

const json = (f: string) => fixture('json', f);

test('GeoJSON variants: pretty, BOM, UTF-16, GeoJSONSeq and JSON Lines', async ({ h }) => {
  const { page } = h;
  await h.mock({ tileMode: 'off', aiEnabled: false });
  await page.goto('/');
  await h.addFiles(...['pretty.geojson', 'bom.geojson', 'utf16.geojson', 'seq.geojson', 'table.jsonl'].map(json));
  await expect.poll(() => h.datasetOptions()).toEqual([
    'bom.geojson · 12 polygon features', 'pretty.geojson · 12 polygon features', 'seq.geojson · 12 polygon features',
    'table.jsonl · 5 rows', 'utf16.geojson · 12 polygon features',
  ]);
  await expect(page.locator('.banner')).toHaveCount(0);
  expectClean(h);
});

test('broken JSON shows a readable error with a snippet', async ({ h }, info) => {
  const { page } = h;
  await h.mock({ tileMode: 'off', aiEnabled: false });
  const bad = info.outputPath('broken.geojson');
  fs.writeFileSync(bad, '{\n  "type": "FeatureCollection",\n  "features": [ {"type": "Feature",, } ]\n}\n');
  await page.goto('/');
  await h.addFiles(bad);
  await expect(page.locator('.banner.err')).toContainText('broken.geojson');
  h.errors.length = 0; // the error is expected and shown in the banner
  expectClean(h);
});

test('large GeoJSON (7,200 polygons) loads and shows on the map', async ({ h }, info) => {
  test.slow();
  const { page } = h;
  await h.mock({ tileMode: 'builtin', aiEnabled: false });
  const src = JSON.parse(fs.readFileSync(json('pretty.geojson'), 'utf8'));
  const features = [];
  for (let i = 0; i < 600; i++) {
    for (const f of src.features) {
      const shift = (c: unknown): unknown => (typeof c === 'number' ? c : Array.isArray(c) && typeof c[0] === 'number'
        ? [c[0] + (i % 30) * 0.5, c[1] + Math.floor(i / 30) * 0.3] : (c as unknown[]).map(shift));
      features.push({ ...f, properties: { ...f.properties, copy: i }, geometry: { ...f.geometry, coordinates: shift(f.geometry.coordinates) } });
    }
  }
  const big = info.outputPath('indonesia_kec_big.geojson');
  fs.writeFileSync(big, JSON.stringify({ type: 'FeatureCollection', features }, null, 1));
  await page.goto('/');

  const t0 = Date.now();
  await h.addFiles(big);
  await expect.poll(() => h.datasetOptions(), { timeout: 60_000 }).toEqual(['indonesia_kec_big.geojson · 7,200 polygon features']);
  const loadMs = Date.now() - t0;
  await page.getByRole('tab', { name: 'Map layers' }).click();
  await expect(page.locator('.layer .badge')).toHaveText(['polygon · 7,200']);
  await page.getByRole('tab', { name: 'Explore' }).click();
  await expect(page.getByText('Field List')).toBeVisible({ timeout: 60_000 });
  info.annotations.push({ type: 'load ms', description: String(loadMs) });
  expect(loadMs).toBeLessThan(30_000);
  expectClean(h);
});
