import { test as base, expect, type Page } from '@playwright/test';
import path from 'node:path';
import zlib from 'node:zlib';

export const FIXTURES = path.resolve(import.meta.dirname, '../fixtures');
export const fixture = (...p: string[]) => path.join(FIXTURES, ...p);

export interface MockOptions {
  /** Tile mode returned by `get_map_settings`. */
  tileMode?: 'builtin' | 'online' | 'cache' | 'off';
  aiEnabled?: boolean;
  /** Replies returned by successive `ai_chat` calls (JSON strings); the last one repeats. */
  aiReplies?: string[];
}

export interface Harness {
  page: Page;
  /** Uncaught page errors and console errors. */
  errors: string[];
  /** Requests that left the app (anything but the local preview server, data: and blob:). */
  external: string[];
  /** Tile requests served through the mocked `tiles:` protocol, as "z/x/y". */
  tiles: string[];
  /** Arguments of every `ai_chat` call. */
  aiCalls: { messages: { role: string; content: string }[] }[];
  mock(opts?: MockOptions): Promise<void>;
  addFiles(...files: string[]): Promise<void>;
  /** Dataset picker entries, sorted (files load concurrently, so order varies). */
  datasetOptions(): Promise<string[]>;
}

/** A 256×256 PNG with a grid line, standing in for backend-rendered tiles. */
export function tilePng(): Buffer {
  const w = 256, stride = w * 3 + 1, raw = Buffer.alloc(stride * w);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * stride + 1 + x * 3, edge = x === 0 || y === 0;
      raw[o] = edge ? 180 : 226; raw[o + 1] = edge ? 190 : 232; raw[o + 2] = edge ? 200 : 222;
    }
  }
  const chunk = (t: string, d: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(w, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const TILE = tilePng();

/**
 * Page fixture with a mocked Tauri backend (`window.__TAURI_INTERNALS__`): settings commands,
 * `ai_chat` and the `tiles:` protocol (served at `/__tiles/`). Nothing reaches a real backend.
 */
export const test = base.extend<{ h: Harness }>({
  h: async ({ page }, use) => {
    const h: Harness = {
      page, errors: [], external: [], tiles: [], aiCalls: [],
      async mock(opts = {}) {
        const replies = [...(opts.aiReplies ?? ['{}'])];
        await page.exposeFunction('__aiChat', (args: Harness['aiCalls'][number]) => {
          h.aiCalls.push(args);
          return replies.length > 1 ? replies.shift() : replies[0];
        });
        await page.route('**/__tiles/**', (route) => {
          h.tiles.push(new URL(route.request().url()).pathname.split('/').slice(-3).join('/'));
          return route.fulfill({ status: 200, contentType: 'image/png', body: TILE });
        });
        await page.addInitScript(({ tileMode, aiEnabled }) => {
          const ai = {
            enabled: aiEnabled, apiStyle: 'openai', baseUrl: 'https://llm.local/v1', model: 'm',
            authHeader: 'Authorization', authPrefix: 'Bearer ', headers: [], verifySsl: false, proxy: '',
            timeoutSecs: 60, temperature: 0.1, maxTokens: 1024,
          };
          let map = {
            settings: {
              mode: tileMode, urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
              attribution: '© OpenStreetMap contributors', headers: [], verifySsl: true, proxy: '',
            },
            revision: 1,
          };
          const w = window as unknown as Record<string, unknown>;
          w.__TAURI_INTERNALS__ = {
            transformCallback: () => 0,
            convertFileSrc: (_p: string, proto: string) => `${location.origin}/__${proto}/`,
            invoke: async (cmd: string, args: Record<string, unknown>) => {
              switch (cmd) {
                case 'get_settings': return { settings: ai, hasApiKey: true };
                case 'get_map_settings': return map;
                case 'save_map_settings':
                  map = { settings: args.settings as typeof map.settings, revision: map.revision + 1 };
                  return map;
                case 'ai_chat': return (w.__aiChat as (a: unknown) => Promise<string>)(args);
                default: throw new Error(`unexpected command ${cmd}`);
              }
            },
          };
        }, { tileMode: opts.tileMode ?? 'builtin', aiEnabled: opts.aiEnabled ?? true });
      },
      async addFiles(...files) {
        await page.setInputFiles('input[type=file]', files);
      },
      async datasetOptions() {
        return (await page.locator('header select').first().locator('option').allTextContents()).sort();
      },
    };
    page.on('pageerror', (e) => h.errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') h.errors.push(m.text()); });
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (u.protocol !== 'data:' && u.protocol !== 'blob:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
        h.external.push(r.url());
      }
    });
    await use(h);
  },
});

/** Every test ends with: no page errors and no request leaving the machine. */
export function expectClean(h: Harness) {
  expect(h.errors, 'page errors').toEqual([]);
  expect(h.external, 'external requests').toEqual([]);
}

export { expect };
