import { useEffect, useMemo, useRef, useState } from 'react';
import { builtInSettings } from '../settings/defaults';
import { loadSettings } from '../settings/remoteSettings';
import { openLocalStore, type LocalStore, type ProfileRecord, type Snapshot } from '../store';
import { Scheduler } from '../store/scheduler';
import { ProfilePanel } from '../profile/ProfilePanel';
import { config, createService, startReadiness, useForeground } from './service';
import { NotebookPanel } from './NotebookPanel';
import { Notices } from './Notices';
import { PlaceholderPage } from './PlaceholderPage';
import { StatusBar } from './StatusBar';

const emptySnapshot = (): Snapshot => ({ paragraphs: [], items: [], profile: [], jobs: [] });
export default function App() {
  const service = useMemo(createService, []);
  const [, refresh] = useState(0);
  const [page, setPage] = useState('Notebook');
  const [text, setText] = useState('');
  const [storageStatus, setStorageStatus] = useState<'loading' | 'saving' | 'saved' | 'error'>('loading');
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const snapshotRef = useRef(snapshot);
  const [settings, setSettings] = useState(builtInSettings);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const storeRef = useRef<LocalStore | null>(null);
  const schedulerRef = useRef<Scheduler | null>(null);
  const writes = useRef<Promise<void>>(Promise.resolve());
  const revision = useRef(0);
  const mounted = useRef(true);
  const clearing = useRef(false);
  const foreground = useForeground();
  useEffect(() => {
    const unsubscribe = service.subscribe(() => refresh(n => n + 1));
    const stopReadiness = startReadiness(service);
    return () => { stopReadiness(); unsubscribe(); };
  }, [service]);
  useEffect(() => {
    let active = true;
    void loadSettings(config).then(value => { if (active) setSettings(value); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    mounted.current = true;
    let opened: LocalStore | null = null;
    let scheduler: Scheduler | null = null;
    const update = () => {
      if (!opened) return;
      void opened.snapshot().then(value => {
        if (mounted.current) { snapshotRef.current = value; setSnapshot(value); }
      })
        .catch(() => { if (mounted.current) setStorageStatus('error'); });
    };
    void (async () => {
      try {
        opened = await openLocalStore();
        if (!mounted.current) { opened.close(); return; }
        await opened.migrate(localStorage);
        const initial = await opened.snapshot();
        if (!mounted.current) { opened.close(); return; }
        storeRef.current = opened;
        snapshotRef.current = initial;
        setSnapshot(initial);
        setText(initial.paragraphs.map(p => p.text).join('\n\n'));
        setStorageStatus('saved');
        scheduler = new Scheduler(opened, service,
          () => settingsRef.current.values.prompt_set === 'v1' ? 'extract.v1' : 'extract.v2', update,
          Date.now, () => { if (mounted.current) setStorageStatus('error'); });
        schedulerRef.current = scheduler;
        await scheduler.start();
      } catch {
        if (mounted.current) setStorageStatus('error');
      }
    })();
    return () => { mounted.current = false; scheduler?.stop(); schedulerRef.current = null;
      storeRef.current = null; opened?.close(); };
  }, [service]);
  const refreshData = async () => {
    const store = storeRef.current;
    if (!store) throw new Error('Local storage unavailable.');
    const next = await store.snapshot();
    if (mounted.current) { snapshotRef.current = next; setSnapshot(next); }
  };
  const save = (value: string) => {
    if (clearing.current) return;
    setText(value);
    const sequence = ++revision.current;
    schedulerRef.current?.edited(value, snapshotRef.current.paragraphs);
    setStorageStatus('saving');
    writes.current = writes.current.catch(() => undefined).then(async () => {
      const store = storeRef.current;
      if (!store) throw new Error('Local storage unavailable.');
      await store.saveNotebook(value);
      await refreshData();
      if (sequence === revision.current && mounted.current) {
        setStorageStatus('saved'); schedulerRef.current?.saved();
      }
    }).catch(() => { if (mounted.current) setStorageStatus('error'); });
  };
  const changeProfile = async (operation: (store: LocalStore) => Promise<void>) => {
    if (clearing.current) throw new Error('Local deletion in progress.');
    const store = storeRef.current;
    if (!store) throw new Error('Local storage unavailable.');
    await operation(store);
    await refreshData();
  };
  const clearAll = async () => {
    if (clearing.current) return;
    clearing.current = true;
    ++revision.current;
    schedulerRef.current?.edited();
    setStorageStatus('saving');
    try {
      await writes.current;
      const store = storeRef.current;
      if (!store) throw new Error('Local storage unavailable.');
      await store.clearAll(localStorage);
      setText('');
      await refreshData();
      setStorageStatus('saved');
      schedulerRef.current?.saved();
    } catch {
      setStorageStatus('error');
      throw new Error('Local deletion failed.');
    } finally {
      clearing.current = false;
    }
  };
  return (
    <div className="app">
      <header className="header"><div><div className="eyebrow">A quieter way to think</div><h1>ThoughtPartner</h1></div>
        <nav aria-label="Main navigation">{['Notebook', 'Profile', 'Outbox', 'Insights'].map(item => (
          <button key={item} aria-current={page === item ? 'page' : undefined} onClick={() => setPage(item)}>
            {item}
          </button>))}</nav></header>
      <Notices configured={config !== null} state={service.state} />
      <main>{page === 'Notebook' ? <NotebookPanel text={text} save={save} storageStatus={storageStatus}
        snapshot={snapshot} configured={config !== null} ready={service.state.kind === 'ready'} /> :
        page === 'Profile' ? <ProfilePanel records={snapshot.profile}
          save={(record: ProfileRecord) => changeProfile(store => store.putProfile(record))}
          remove={id => changeProfile(store => store.deleteProfile(id))}
          replace={records => changeProfile(store => store.replaceProfile(records))} clearAll={clearAll} /> :
          <PlaceholderPage page={page} />}</main>
      <StatusBar service={service} configured={config !== null} foreground={foreground} settings={settings} />
    </div>
  );
}
