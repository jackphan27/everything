import { useEffect, useState } from 'react';
import { getSettings, saveSettings, testAi, type AiSettings, type HeaderEntry } from './settings';

interface Props {
  onClose: (saved?: AiSettings) => void;
}

export default function SettingsDialog({ onClose }: Props) {
  const [s, setS] = useState<AiSettings | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [apiKey, setApiKey] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getSettings()
      .then((v) => { setS(v.settings); setHasKey(v.hasApiKey); })
      .catch((e) => setStatus({ ok: false, text: String(e) }));
  }, []);

  if (!s) return <div className="modal-backdrop"><div className="modal">Loading…</div></div>;

  const set = <K extends keyof AiSettings>(k: K, v: AiSettings[K]) => setS({ ...s, [k]: v });
  const setHeader = (i: number, patch: Partial<HeaderEntry>) =>
    set('headers', s.headers.map((h, j) => (j === i ? { ...h, ...patch } : h)));

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setStatus(null);
    try { await fn(); } catch (e) { setStatus({ ok: false, text: String(e) }); } finally { setBusy(false); }
  };

  const onTest = () => run(async () => {
    const reply = await testAi(s, apiKey);
    setStatus({ ok: true, text: `Connected. Model replied: ${reply.slice(0, 200)}` });
  });

  const onSave = () => run(async () => {
    const v = await saveSettings(s, apiKey);
    setHasKey(v.hasApiKey);
    onClose(v.settings);
  });

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="AI settings">
        <h2>AI settings</h2>
        <p className="hint">
          Requests go from this app's local backend straight to the endpoint below. Only field names and types
          are sent, never your rows. The API key is stored in Windows Credential Manager.
        </p>

        <label className="row check">
          <input type="checkbox" checked={s.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          Enable AI chart assistant
        </label>

        <div className="grid">
          <label>API format
            <select value={s.apiStyle} onChange={(e) => set('apiStyle', e.target.value as AiSettings['apiStyle'])}>
              <option value="openai">OpenAI-compatible (/chat/completions)</option>
              <option value="anthropic">Anthropic (/messages)</option>
            </select>
          </label>
          <label>Model
            <input value={s.model} onChange={(e) => set('model', e.target.value)} placeholder="gpt-4o-mini" />
          </label>
          <label className="span2">Base URL
            <input value={s.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} placeholder="https://llm.mycorp.local/v1" />
          </label>
          <label>API key
            <input
              type="password"
              value={apiKey ?? ''}
              placeholder={hasKey ? '•••••••• (saved — leave blank to keep)' : 'not set'}
              onChange={(e) => setApiKey(e.target.value || undefined)}
              autoComplete="off"
            />
          </label>
          <label>Key header / prefix
            <span className="pair">
              <input value={s.authHeader} onChange={(e) => set('authHeader', e.target.value)} placeholder="Authorization" />
              <input value={s.authPrefix} onChange={(e) => set('authPrefix', e.target.value)} placeholder="Bearer " />
            </span>
          </label>
        </div>
        {hasKey && (
          <button className="link" onClick={() => run(async () => { const v = await saveSettings(s, ''); setHasKey(v.hasApiKey); setApiKey(undefined); })}>
            Remove saved key
          </button>
        )}

        <h3>Custom headers</h3>
        {s.headers.map((h, i) => (
          <div className="pair" key={i}>
            <input value={h.name} onChange={(e) => setHeader(i, { name: e.target.value })} placeholder="Header-Name" />
            <input value={h.value} onChange={(e) => setHeader(i, { value: e.target.value })} placeholder="value" />
            <button onClick={() => set('headers', s.headers.filter((_, j) => j !== i))} title="Remove">✕</button>
          </div>
        ))}
        <button onClick={() => set('headers', [...s.headers, { name: '', value: '' }])}>+ Add header</button>

        <h3>Connection</h3>
        <label className="row check">
          <input type="checkbox" checked={s.verifySsl} onChange={(e) => set('verifySsl', e.target.checked)} />
          Verify SSL certificates
        </label>
        {!s.verifySsl && (
          <p className="warn">SSL verification is off: any certificate is accepted for the AI endpoint. Use only on a trusted internal network.</p>
        )}
        <div className="grid">
          <label>Proxy (optional)
            <input value={s.proxy} onChange={(e) => set('proxy', e.target.value)} placeholder="http://proxy:8080" />
          </label>
          <label>Timeout (s)
            <input type="number" min={5} value={s.timeoutSecs} onChange={(e) => set('timeoutSecs', Number(e.target.value))} />
          </label>
          <label>Temperature
            <input type="number" step={0.1} min={0} max={2} value={s.temperature} onChange={(e) => set('temperature', Number(e.target.value))} />
          </label>
          <label>Max tokens
            <input type="number" min={64} value={s.maxTokens} onChange={(e) => set('maxTokens', Number(e.target.value))} />
          </label>
        </div>

        {status && <pre className={status.ok ? 'ok' : 'err'}>{status.text}</pre>}

        <div className="actions">
          <button onClick={onTest} disabled={busy}>Test connection</button>
          <span className="spacer" />
          <button onClick={() => onClose()} disabled={busy}>Cancel</button>
          <button className="primary" onClick={onSave} disabled={busy}>Save</button>
        </div>
      </div>
    </div>
  );
}
