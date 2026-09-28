import { useState } from 'react';
import type { HeaderEntry } from './settings';
import { clearTileCache, saveMapSettings, testTiles, type MapSettings, type MapSettingsView } from './tiles';

const PRESETS: { label: string; url: string; attribution: string }[] = [
  { label: 'OpenStreetMap', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors' },
  { label: 'OpenStreetMap HOT', url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors, HOT' },
  { label: 'OpenTopoMap', url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)' },
];

interface Props {
  initial: MapSettings;
  onClose: (saved?: MapSettingsView) => void;
}

export default function BasemapDialog({ initial, onClose }: Props) {
  const [s, setS] = useState<MapSettings>(initial);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof MapSettings>(k: K, v: MapSettings[K]) => setS({ ...s, [k]: v });
  const setHeader = (i: number, patch: Partial<HeaderEntry>) =>
    set('headers', s.headers.map((h, j) => (j === i ? { ...h, ...patch } : h)));

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setStatus(null);
    try { await fn(); } catch (e) { setStatus({ ok: false, text: String(e) }); } finally { setBusy(false); }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Basemap settings">
        <h2>Basemap</h2>
        <p className="hint">
          The built-in map (land, coastlines, borders from Natural Earth) is stored inside the app and needs no internet.
          Online tiles are fetched by the app's backend and cached on disk. If the server can't be reached, the built-in map
          is shown instead. Only tile coordinates are sent to the tile server, never your data.
        </p>
        <label>Mode
          <select value={s.mode} onChange={(e) => set('mode', e.target.value as MapSettings['mode'])}>
            <option value="builtin">Built-in offline map — no internet needed</option>
            <option value="online">Online tiles — fetch, cache, fall back to built-in</option>
            <option value="cache">Cached online tiles only — no network</option>
            <option value="off">None — no basemap</option>
          </select>
        </label>
        <label>Preset
          <select value="" onChange={(e) => { const p = PRESETS[Number(e.target.value)]; if (p) setS({ ...s, urlTemplate: p.url, attribution: p.attribution }); }}>
            <option value="">Choose a preset…</option>
            {PRESETS.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
          </select>
        </label>
        <label>Tile URL template ({'{z}'}, {'{x}'}, {'{y}'}, optional {'{s}'})
          <input value={s.urlTemplate} onChange={(e) => set('urlTemplate', e.target.value)} placeholder="https://tiles.mycorp.local/{z}/{x}/{y}.png" />
        </label>
        <label>Attribution
          <input value={s.attribution} onChange={(e) => set('attribution', e.target.value)} />
        </label>

        <h3>Headers for the tile server</h3>
        {s.headers.map((h, i) => (
          <div className="pair" key={i}>
            <input value={h.name} onChange={(e) => setHeader(i, { name: e.target.value })} placeholder="Header-Name" />
            <input value={h.value} onChange={(e) => setHeader(i, { value: e.target.value })} placeholder="value" />
            <button onClick={() => set('headers', s.headers.filter((_, j) => j !== i))} title="Remove">✕</button>
          </div>
        ))}
        <button onClick={() => set('headers', [...s.headers, { name: '', value: '' }])}>+ Add header</button>

        <label className="row check">
          <input type="checkbox" checked={s.verifySsl} onChange={(e) => set('verifySsl', e.target.checked)} />
          Verify SSL certificates
        </label>
        <label>Proxy (optional)
          <input value={s.proxy} onChange={(e) => set('proxy', e.target.value)} placeholder="http://proxy:8080" />
        </label>

        {status && <pre className={status.ok ? 'ok' : 'err'}>{status.text}</pre>}
        <div className="actions">
          <button disabled={busy} onClick={() => run(async () => setStatus({ ok: true, text: await testTiles(s) }))}>
            Test tile server
          </button>
          <button disabled={busy} onClick={() => run(async () => { await clearTileCache(); setStatus({ ok: true, text: 'Tile cache cleared.' }); })}>
            Clear tile cache
          </button>
          <span className="spacer" />
          <button onClick={() => onClose()} disabled={busy}>Cancel</button>
          <button className="primary" disabled={busy} onClick={() => run(async () => onClose(await saveMapSettings(s)))}>Save</button>
        </div>
      </div>
    </div>
  );
}
