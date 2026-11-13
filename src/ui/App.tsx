import { useEffect, useMemo, useState } from 'react';
import { builtInSettings } from '../settings/defaults';
import { loadSettings } from '../settings/remoteSettings';
import { config, createService, useForeground } from './service';
import { NotebookPanel } from './NotebookPanel';
import { Notices } from './Notices';
import { PlaceholderPage } from './PlaceholderPage';
import { StatusBar } from './StatusBar';

export default function App() {
  const service = useMemo(createService, []);
  const [, refresh] = useState(0);
  const [page, setPage] = useState('Notebook');
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem('thoughtpartner-notebook') ?? '';
    } catch {
      return '';
    }
  });
  const [storageError, setStorageError] = useState(false);
  const [settings, setSettings] = useState(builtInSettings);
  const foreground = useForeground();
  useEffect(() => {
    const unsubscribe = service.subscribe(() => refresh((n) => n + 1));
    void service.probe();
    return unsubscribe;
  }, [service]);
  useEffect(() => {
    let active = true;
    void loadSettings(config).then((snapshot) => {
      if (active) setSettings(snapshot);
    });
    return () => { active = false; };
  }, []);
  const save = (value: string) => {
    setText(value);
    try {
      localStorage.setItem('thoughtpartner-notebook', value);
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  };
  return (
    <div className="app">
      <header className="header">
        <div>
          <div className="eyebrow">A quieter way to think</div>
          <h1>ThoughtPartner</h1>
        </div>
        <nav aria-label="Main navigation">
          {['Notebook', 'Profile', 'Outbox', 'Insights'].map((item) => (
            <button
              key={item}
              aria-current={page === item ? 'page' : undefined}
              onClick={() => setPage(item)}
            >
              {item}
            </button>
          ))}
        </nav>
      </header>
      <Notices configured={config !== null} state={service.state} />
      <main>
        {page === 'Notebook' ? (
          <NotebookPanel text={text} save={save} storageError={storageError} />
        ) : (
          <PlaceholderPage page={page} />
        )}
      </main>
      <StatusBar service={service} configured={config !== null} foreground={foreground} settings={settings} />
    </div>
  );
}
