import { useEffect, useMemo, useState } from 'react';
import { readConfig } from '../config';
import { browserApi, makeFirebaseModel } from '../ai/firebase';
import { languageOptions, LocalModelService } from '../ai/localModel';
import { NotebookPanel } from './NotebookPanel';
import { Notices } from './Notices';
import { PlaceholderPage } from './PlaceholderPage';
import { StatusBar } from './StatusBar';

export const config = readConfig(import.meta.env);
export function createService() {
  return new LocalModelService({
    configured: config !== null,
    hasApi: () => typeof browserApi()?.availability === 'function',
    availability: () => browserApi()!.availability(languageOptions),
    createModel: () => {
      if (!config) {
        throw new Error('Firebase is not configured.');
      }
      return makeFirebaseModel(config);
    },
    isForeground: () => document.visibilityState === 'visible',
    onForeground: (callback) => {
      document.addEventListener('visibilitychange', callback);
      return () => document.removeEventListener('visibilitychange', callback);
    },
    now: () => performance.now(),
  });
}
export function useForeground() {
  const [isForeground, setForeground] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    const update = () => setForeground(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return isForeground;
}
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
  const foreground = useForeground();
  useEffect(() => {
    const unsubscribe = service.subscribe(() => refresh((n) => n + 1));
    void service.probe();
    return unsubscribe;
  }, [service]);
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
      <StatusBar service={service} configured={config !== null} foreground={foreground} />
    </div>
  );
}
