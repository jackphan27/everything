//! Built-in offline basemap: Natural Earth land, coastlines and country borders embedded in
//! the executable and rasterised into 256px XYZ tiles on demand. No network needed.
//! Data: 1:50m for the world, 1:10m around Southeast Asia (see scripts/build-basemap.mjs).

use std::sync::OnceLock;

use tiny_skia::{Color, FillRule, Paint, PathBuilder, Pixmap, Stroke, Transform};

static DATA: &[u8] = include_bytes!("../assets/basemap.bin");

/// [west, south, east, north]; must match REGION in scripts/build-basemap.mjs.
const DETAIL_REGION: [f64; 4] = [80.0, -20.0, 160.0, 25.0];
const DETAIL_MIN_ZOOM: u32 = 6;
const TILE: f64 = 256.0;
/// Clip slightly outside the tile so strokes at the edge are drawn fully.
const PAD: f64 = 4.0;

const OCEAN: (u8, u8, u8) = (0xd3, 0xe3, 0xf0);
const LAND: (u8, u8, u8) = (0xf4, 0xf2, 0xec);
const COAST: (u8, u8, u8) = (0x8f, 0xab, 0xc2);
const BORDER: (u8, u8, u8) = (0xa0, 0x98, 0x90);

struct Shape {
    is_land: bool,
    /// Rings in Web-Mercator unit space (0..1 on both axes).
    rings: Vec<Vec<(f64, f64)>>,
    bbox: [f64; 4],
}

struct Sets {
    world: Vec<Shape>,
    detail: Vec<Shape>,
}

fn mercator(lon: f64, lat: f64) -> (f64, f64) {
    let lat = lat.clamp(-85.051_128, 85.051_128).to_radians();
    let x = (lon + 180.0) / 360.0;
    let y = (1.0 - (lat.tan() + 1.0 / lat.cos()).ln() / std::f64::consts::PI) / 2.0;
    (x, y)
}

struct Reader<'a> {
    b: &'a [u8],
    i: usize,
}

impl Reader<'_> {
    fn u8(&mut self) -> u8 {
        let v = self.b[self.i];
        self.i += 1;
        v
    }
    fn varint(&mut self) -> u64 {
        let (mut v, mut shift) = (0u64, 0);
        loop {
            let byte = self.u8();
            v |= ((byte & 0x7f) as u64) << shift;
            if byte & 0x80 == 0 {
                return v;
            }
            shift += 7;
        }
    }
    fn zigzag(&mut self) -> i64 {
        let v = self.varint();
        ((v >> 1) as i64) ^ -((v & 1) as i64)
    }
    fn set(&mut self) -> Vec<Shape> {
        let n = self.varint() as usize;
        (0..n)
            .map(|_| {
                let is_land = self.u8() == 0;
                let n_rings = self.varint() as usize;
                let mut bbox = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
                let rings = (0..n_rings)
                    .map(|_| {
                        let n_pts = self.varint() as usize;
                        let (mut qx, mut qy) = (0i64, 0i64);
                        (0..n_pts)
                            .map(|_| {
                                qx += self.zigzag();
                                qy += self.zigzag();
                                let p = mercator(qx as f64 / 1e5, qy as f64 / 1e5);
                                bbox = [bbox[0].min(p.0), bbox[1].min(p.1), bbox[2].max(p.0), bbox[3].max(p.1)];
                                p
                            })
                            .collect()
                    })
                    .collect();
                Shape { is_land, rings, bbox }
            })
            .collect()
    }
}

fn sets() -> &'static Sets {
    static SETS: OnceLock<Sets> = OnceLock::new();
    SETS.get_or_init(|| {
        assert_eq!(&DATA[..4], b"GWBM", "corrupt basemap asset");
        let mut r = Reader { b: DATA, i: 5 };
        let world = r.set();
        let detail = r.set();
        Sets { world, detail }
    })
}

/// Sutherland–Hodgman against the padded tile square (pixel space). Good enough for
/// even-odd fills: artificial edges along the clip border are never stroked.
fn clip_polygon(ring: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let (lo, hi) = (-PAD, TILE + PAD);
    let mut pts = ring.to_vec();
    for edge in 0..4 {
        if pts.is_empty() {
            break;
        }
        let inside = |p: &(f64, f64)| match edge {
            0 => p.0 >= lo,
            1 => p.0 <= hi,
            2 => p.1 >= lo,
            _ => p.1 <= hi,
        };
        let cross = |a: (f64, f64), b: (f64, f64)| {
            let t = match edge {
                0 => (lo - a.0) / (b.0 - a.0),
                1 => (hi - a.0) / (b.0 - a.0),
                2 => (lo - a.1) / (b.1 - a.1),
                _ => (hi - a.1) / (b.1 - a.1),
            };
            (a.0 + t * (b.0 - a.0), a.1 + t * (b.1 - a.1))
        };
        let mut out = Vec::with_capacity(pts.len());
        for i in 0..pts.len() {
            let (cur, prev) = (pts[i], pts[(i + pts.len() - 1) % pts.len()]);
            match (inside(&cur), inside(&prev)) {
                (true, true) => out.push(cur),
                (true, false) => {
                    out.push(cross(prev, cur));
                    out.push(cur);
                }
                (false, true) => out.push(cross(prev, cur)),
                (false, false) => {}
            }
        }
        pts = out;
    }
    pts
}

/// Liang–Barsky: clip one segment to the padded tile square.
fn clip_segment(a: (f64, f64), b: (f64, f64)) -> Option<((f64, f64), (f64, f64))> {
    let (lo, hi) = (-PAD, TILE + PAD);
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let (mut t0, mut t1) = (0.0f64, 1.0f64);
    for (p, q) in [(-dx, a.0 - lo), (dx, hi - a.0), (-dy, a.1 - lo), (dy, hi - a.1)] {
        if p == 0.0 {
            if q < 0.0 {
                return None;
            }
        } else {
            let r = q / p;
            if p < 0.0 {
                t0 = t0.max(r);
            } else {
                t1 = t1.min(r);
            }
            if t0 > t1 {
                return None;
            }
        }
    }
    Some(((a.0 + t0 * dx, a.1 + t0 * dy), (a.0 + t1 * dx, a.1 + t1 * dy)))
}

fn add_polyline(pb: &mut PathBuilder, pts: &[(f64, f64)]) {
    let mut last: Option<(f64, f64)> = None;
    for w in pts.windows(2) {
        if let Some((a, b)) = clip_segment(w[0], w[1]) {
            if last != Some(a) {
                pb.move_to(a.0 as f32, a.1 as f32);
            }
            pb.line_to(b.0 as f32, b.1 as f32);
            last = Some(b);
        } else {
            last = None;
        }
    }
}

fn paint(rgb: (u8, u8, u8)) -> Paint<'static> {
    let mut p = Paint::default();
    p.set_color(Color::from_rgba8(rgb.0, rgb.1, rgb.2, 255));
    p.anti_alias = true;
    p
}

/// Render tile z/x/y as PNG bytes.
pub fn render_tile(z: u32, x: u32, y: u32) -> Vec<u8> {
    let n = (1u64 << z) as f64;
    let scale = TILE * n;
    let (ox, oy) = (x as f64 * TILE, y as f64 * TILE);
    let pad = PAD / scale;
    let tile_box = [x as f64 / n - pad, y as f64 / n - pad, (x + 1) as f64 / n + pad, (y + 1) as f64 / n + pad];

    // Use the 1:10m set when the whole tile lies inside the detail region.
    let (w, nth) = (tile_box[0] * 360.0 - 180.0, tile_box[1]);
    let (e, sth) = (tile_box[2] * 360.0 - 180.0, tile_box[3]);
    let lat = |yu: f64| (std::f64::consts::PI * (1.0 - 2.0 * yu)).sinh().atan().to_degrees();
    let inside_detail = w >= DETAIL_REGION[0] && e <= DETAIL_REGION[2] && lat(sth) >= DETAIL_REGION[1] && lat(nth) <= DETAIL_REGION[3];
    let s = sets();
    let shapes = if z >= DETAIL_MIN_ZOOM && inside_detail { &s.detail } else { &s.world };

    let mut pixmap = Pixmap::new(TILE as u32, TILE as u32).expect("tile pixmap");
    pixmap.fill(Color::from_rgba8(OCEAN.0, OCEAN.1, OCEAN.2, 255));

    let visible = |sh: &&Shape| !(sh.bbox[2] < tile_box[0] || sh.bbox[0] > tile_box[2] || sh.bbox[3] < tile_box[1] || sh.bbox[1] > tile_box[3]);
    let to_px = |ring: &Vec<(f64, f64)>| ring.iter().map(|&(ux, uy)| (ux * scale - ox, uy * scale - oy)).collect::<Vec<_>>();

    let mut land = PathBuilder::new();
    let mut coast = PathBuilder::new();
    let mut borders = PathBuilder::new();
    for sh in shapes.iter().filter(visible) {
        for ring in &sh.rings {
            let px = to_px(ring);
            if sh.is_land {
                let clipped = clip_polygon(&px);
                if clipped.len() >= 3 {
                    land.move_to(clipped[0].0 as f32, clipped[0].1 as f32);
                    for p in &clipped[1..] {
                        land.line_to(p.0 as f32, p.1 as f32);
                    }
                    land.close();
                }
                add_polyline(&mut coast, &px);
            } else {
                add_polyline(&mut borders, &px);
            }
        }
    }

    let id = Transform::identity();
    if let Some(path) = land.finish() {
        pixmap.fill_path(&path, &paint(LAND), FillRule::EvenOdd, id, None);
    }
    let line = |width: f32| Stroke { width, ..Stroke::default() };
    if let Some(path) = coast.finish() {
        pixmap.stroke_path(&path, &paint(COAST), &line(if z < 4 { 0.5 } else { 0.8 }), id, None);
    }
    if z >= 2 {
        if let Some(path) = borders.finish() {
            pixmap.stroke_path(&path, &paint(BORDER), &line(if z < 5 { 0.6 } else { 1.0 }), id, None);
        }
    }
    pixmap.encode_png().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_both_sets() {
        let s = sets();
        assert!(s.world.len() > 1000 && s.detail.len() > 500);
    }

    #[test]
    fn renders_png_tiles() {
        for (z, x, y) in [(0, 0, 0), (5, 25, 16), (8, 203, 132), (14, 13048, 8472)] {
            let png = render_tile(z, x, y);
            assert_eq!(&png[1..4], b"PNG", "tile {z}/{x}/{y}");
        }
    }

    #[test]
    fn clips_segments() {
        assert!(clip_segment((-100.0, 10.0), (-50.0, 10.0)).is_none());
        let (a, b) = clip_segment((-100.0, 10.0), (100.0, 10.0)).unwrap();
        assert_eq!((a.0, b.0), (-PAD, 100.0));
    }
}
