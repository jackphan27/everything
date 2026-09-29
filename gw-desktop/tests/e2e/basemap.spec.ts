import { test, expect, expectClean, fixture } from './harness';

test('built-in offline basemap is the default in both views', async ({ h }) => {
  const { page } = h;
  await h.mock({
    tileMode: 'builtin',
    aiReplies: [JSON.stringify({
      mark: 'poi', longitude: 'longitude', latitude: 'latitude', color: 'wa_poor_quality_rate', details: ['cgisai'],
      config: { coordSystem: 'geographic', geoms: ['poi'] },
    })],
  });
  await page.goto('/');
  await h.addFiles(fixture('geo', 'kecamatan.zip'), fixture('geo', 'poi.csv'));
  await page.getByRole('tab', { name: 'Map layers' }).click();
  await expect(page.locator('.leaflet-container')).toBeVisible();
  await expect(page.locator('.basemap select')).toHaveValue('builtin');
  await expect(page.locator('.leaflet-control-attribution')).toContainText('Natural Earth');
  await expect.poll(() => h.tiles.length).toBeGreaterThan(0);
  expect(h.tiles.every((t) => /^\d+\/\d+\/\d+$/.test(t)), `tile paths ${h.tiles}`).toBe(true);

  await page.getByRole('tab', { name: 'Explore' }).click();
  await page.locator('header select').first().selectOption({ label: 'poi.csv · 96 rows' });
  const before = h.tiles.length;
  await page.getByPlaceholder('What visualization').fill('map');
  await page.locator('#askviz_ask').click();
  await expect.poll(() => h.tiles.length, { timeout: 15_000 }).toBeGreaterThan(before);
  expectClean(h);
});
