import { test, expect, expectClean, fixture } from './harness';

test('opens fast, loads a CSV and draws AI charts without sending rows', async ({ h }) => {
  const { page } = h;
  await h.mock({
    aiReplies: [
      JSON.stringify({ mark: 'bar', name: 'Sales by region', x: 'Region', y: 'sum(Sales)' }),
      JSON.stringify({ mark: 'line', x: { field: 'Order Date', timeUnit: 'month' }, y: 'count(*)', color: 'Category' }),
    ],
  });

  const t0 = Date.now();
  await page.goto('/');
  await expect(page.getByText('Drop CSV, JSON, GeoJSON or shapefiles here')).toBeVisible();
  expect(Date.now() - t0, 'app shell visible').toBeLessThan(5000);

  await h.addFiles(fixture('sales.csv'));
  await expect(page.locator('header select').first()).toContainText('sales.csv · 5,000 rows');

  const ask = page.locator('#askviz_ask');
  await expect(ask).toBeVisible({ timeout: 30_000 });
  for (const [i, question] of ['sales by region', 'orders per month by category'].entries()) {
    await page.getByPlaceholder('What visualization').fill(question);
    await ask.click();
    await expect.poll(() => h.aiCalls.length).toBe(i + 1);
    // A chart is drawn (Vega renders a canvas or svg inside the chart area).
    await expect(page.locator('.vega-embed canvas, .vega-embed svg').first()).toBeVisible({ timeout: 15_000 });
  }

  // The model sees field names and types, never row values.
  const sent = JSON.stringify(h.aiCalls);
  expect(sent).toContain('Region');
  expect(sent).toContain('Sales');
  for (const rowValue of ['110.54', '2024-05-17', 'East', 'Office']) expect(sent).not.toContain(rowValue);
  // count(*) in a reply must not break the chart (rewritten to count()).
  expect(h.errors.join('\n')).not.toContain("Unknown field '*'");
  expectClean(h);
});
