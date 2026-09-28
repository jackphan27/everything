import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { IDarkMode } from '@kanaries/graphic-walker';
import { loadFile, type Dataset } from './data';
import { getSettings } from './settings';

// Split the heavy visualisation bundle out of the startup path.
const Walker = lazy(() => import('./Walker'));
const SettingsDialog = lazy(() => import('./SettingsDialog'));
// Start fetching/parsing the Walker chunk right after first paint, while the user picks a file.
const prefetchWalker = () => void import('./Walker');

export default function App() {
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [appearance, setAppearance] = useState<IDarkMode>('media');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getSettings().then((v) => setAiEnabled(v.settings.enabled)).catch(() => {});
    const id = requestIdleCallback(prefetchWalker, { timeout: 1500 });
    return () => cancelIdleCallback(id);
  }, []);

  const open = useCallback(async (file?: File) => {
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      setDataset(await loadFile(file));
    } catch (e) {
      setError(`Could not open ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <div
      className="app"
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={(e) => { e.preventDefault(); setDragging(false); open(e.dataTransfer.files[0]); }}
    >
      <header className="toolbar">
        <button className="primary" onClick={() => inputRef.current?.click()} disabled={loading}>
          {loading ? 'Loading…' : 'Open data…'}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.tsv,.txt,.json,.jsonl,.ndjson"
          hidden
          onChange={(e) => { open(e.target.files?.[0]); e.target.value = ''; }}
        />
        <span className="title">{dataset ? `${dataset.name} · ${dataset.rows.length.toLocaleString()} rows` : 'No data loaded'}</span>
        <span className="spacer" />
        <select value={appearance} onChange={(e) => setAppearance(e.target.value as IDarkMode)} title="Theme">
          <option value="media">System theme</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
        <button onClick={() => setShowSettings(true)}>AI settings{aiEnabled ? ' ●' : ''}</button>
      </header>

      {error && <div className="banner err">{error}</div>}

      <main className="content">
        {dataset ? (
          <Suspense fallback={<div className="empty">Starting visual editor…</div>}>
            <Walker dataset={dataset} appearance={appearance} aiEnabled={aiEnabled} />
          </Suspense>
        ) : (
          <div className={`empty drop ${dragging ? 'over' : ''}`} onClick={() => inputRef.current?.click()}>
            <strong>Drop a CSV, TSV or JSON file here</strong>
            <span>or click to browse. Files are read locally and never uploaded.</span>
          </div>
        )}
      </main>

      {showSettings && (
        <Suspense fallback={null}>
          <SettingsDialog
            onClose={(saved) => {
              setShowSettings(false);
              if (saved) setAiEnabled(saved.enabled);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
