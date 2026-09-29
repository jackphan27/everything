import { test, expect, expectClean, fixture } from './harness';

const geo = (f: string) => fixture('geo', f);

test('multi-layer map: shapefile, points and lines, joined colours, basemap off', async ({ h }) => {
  const { page } = h;
  await h.mock({
    tileMode: 'online',
    aiReplies: [JSON.stringify({
      mark: 'poi', longitude: 'longitude', latitude: 'latitude', color: 'wa_poor_quality_rate',
      config: { coordSystem: 'geographic', geoms: ['poi'] },
    })],
  });
  await page.goto('/');

  await h.addFiles(geo('kecamatan.zip'), geo('poi.csv'), geo('roads.geojson'));
  await expect(page.getByRole('tab', { name: 'Map layers' })).toBeVisible();
  await expect.poll(() => h.datasetOptions()).toEqual([
    'kecamatan · 12 polygon features', 'poi.csv · 96 rows', 'roads.geojson · 2 line features',
  ]);

  // Loose shapefile parts are grouped into one dataset.
  await h.addFiles(geo('kecamatan.shp'), geo('kecamatan.dbf'), geo('kecamatan.prj'), geo('kecamatan.shx'));
  await expect.poll(async () => (await h.datasetOptions()).length).toBe(4);

  await page.getByRole('tab', { name: 'Map layers' }).click();
  await expect(page.locator('.leaflet-container')).toBeVisible();
  await expect(page.locator('.layer .badge')).toHaveText(['point · 96', 'line · 2', 'polygon · 12', 'polygon · 12']);
  await expect.poll(() => h.tiles.length, 'basemap tiles via the tiles: protocol').toBeGreaterThan(0);

  // Remove the duplicate layer, then colour kecamatan polygons by a rate joined from poi.csv.
  await page.locator('.layer').last().locator('button[title="Remove from map"]').click();
  await expect(page.locator('.layer')).toHaveCount(3);
  await page.locator('.layer-name', { hasText: 'kecamatan' }).first().click();
  await page.getByLabel('Colour by').selectOption('__joined__');
  const join = page.locator('.join select');
  await join.nth(0).selectOption({ label: 'poi.csv' });
  await join.nth(1).selectOption('id_kec');
  await join.nth(2).selectOption('id_kec');
  await join.nth(4).selectOption('wa_poor_quality_rate');
  await expect(page.locator('.join .hint')).toHaveText('Matched 12 of 12 features');
  await expect(page.locator('.legend li')).toHaveCount(6); // 5 classes + no data

  // Basemap off removes the tile layer.
  await page.locator('.basemap select').selectOption('off');
  await expect(page.locator('.leaflet-tile-pane img')).toHaveCount(0);
  await page.locator('.basemap select').selectOption('online');

  // Graphic Walker's own POI map also gets its tiles from the tiles: protocol.
  await page.getByRole('tab', { name: 'Explore' }).click();
  await page.locator('header select').first().selectOption({ label: 'poi.csv · 96 rows' });
  const before = h.tiles.length;
  await page.getByPlaceholder('What visualization').fill('map points');
  await page.locator('#askviz_ask').click();
  await expect.poll(() => h.tiles.length, { timeout: 15_000 }).toBeGreaterThan(before);
  expectClean(h);
});

test('switching views while the map is zooming does not throw', async ({ h }) => {
  const { page } = h;
  await h.mock({ tileMode: 'builtin', aiEnabled: false });
  await page.goto('/');
  await h.addFiles(geo('kecamatan.zip'), geo('poi.csv'), geo('roads.geojson'));
  const mapTab = page.getByRole('tab', { name: 'Map layers' });
  const exploreTab = page.getByRole('tab', { name: 'Explore' });
  for (let i = 0; i < 6; i++) {
    await mapTab.click();
    await expect(page.locator('.leaflet-container')).toBeVisible();
    await page.locator('.leaflet-control-zoom-in').click(); // starts a 250 ms zoom animation
    await exploreTab.click(); // unmount the map mid-animation
    await page.waitForTimeout(300 + i * 20);
  }
  expectClean(h);
});
