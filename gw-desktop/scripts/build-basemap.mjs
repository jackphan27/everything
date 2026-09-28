// Builds src-tauri/assets/basemap.bin from Natural Earth (via the world-atlas package):
//   set 0: 1:50m land + country borders, whole world (all zooms)
//   set 1: 1:10m land + country borders around Southeast Asia (used at zoom >= 6 inside that region)
// Encoding: coordinates in 1e-5 degrees, zigzag-varint deltas per ring. Run:
//   npm i --no-save world-atlas@2 topojson-client@3 && node scripts/build-basemap.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as topojson from 'topojson-client';

const require = createRequire(import.meta.url);
const atlas = (f) => JSON.parse(readFileSync(require.resolve(`world-atlas/${f}`), 'utf8'));
const REGION = [80, -20, 160, 25]; // must match DETAIL_REGION in src-tauri/src/basemap.rs

const bytes = [];
const u8 = (v) => bytes.push(v);
const varint = (v) => { while (v > 0x7f) { u8((v & 0x7f) | 0x80); v = Math.floor(v / 128); } u8(v); };
const zigzag = (v) => (v >= 0 ? v * 2 : -v * 2 - 1);

function bbox(rings) {
  let [a, b, c, d] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of rings) for (const [x, y] of r) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
  return [a, b, c, d];
}
const intersects = (bb) => !(bb[2] < REGION[0] || bb[0] > REGION[2] || bb[3] < REGION[1] || bb[1] > REGION[3]);

function paths(topo, clip) {
  const out = [];
  const land = topojson.feature(topo, topo.objects.land ?? topojson.merge(topo, topo.objects.countries.geometries));
  const geoms = land.type === 'FeatureCollection' ? land.features.map((f) => f.geometry) : [land.geometry];
  for (const g of geoms) {
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    for (const rings of polys) if (!clip || intersects(bbox(rings))) out.push([0, rings]);
  }
  const borders = topojson.mesh(topo, topo.objects.countries, (a, b) => a !== b);
  for (const line of borders.coordinates) if (!clip || intersects(bbox([line]))) out.push([1, [line]]);
  return out;
}

function writeSet(list) {
  varint(list.length);
  let points = 0;
  for (const [kind, rings] of list) {
    u8(kind);
    varint(rings.length);
    for (const ring of rings) {
      varint(ring.length);
      let px = 0, py = 0;
      for (const [x, y] of ring) {
        const qx = Math.round(x * 1e5), qy = Math.round(y * 1e5);
        varint(zigzag(qx - px)); varint(zigzag(qy - py));
        px = qx; py = qy; points++;
      }
    }
  }
  return points;
}

for (const c of 'GWBM') u8(c.charCodeAt(0));
u8(1);
const p0 = writeSet(paths(atlas('countries-50m.json'), false));
const p1 = writeSet(paths(atlas('countries-10m.json'), true));
writeFileSync(new URL('../src-tauri/assets/basemap.bin', import.meta.url), Buffer.from(bytes));
console.log(`world 50m: ${p0} points, SE Asia 10m: ${p1} points, ${(bytes.length / 1024).toFixed(0)} KiB`);
