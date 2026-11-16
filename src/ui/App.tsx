import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { builtInSettings } from '../settings/defaults';
import { loadSettings } from '../settings/remoteSettings';
import { openLocalStore, type LocalStore, type ProfileRecord, type Snapshot } from '../store';
import { Scheduler } from '../store/scheduler';
import { ProfilePanel } from '../profile/ProfilePanel';
import { config, createService, startReadiness, useForeground } from './service';
import { NotebookPanel } from './NotebookPanel';
import { OutboxPage } from './OutboxPage';
import { Notices } from './Notices';
import { StatusBar } from './StatusBar';
import { STORAGE_BLOCKED_NOTICE, STORAGE_OUTDATED_NOTICE } from './storageNotices';
import { createCloudAdapter } from '../ai/cloudResearch';
import { researchApproved, type ResearchView } from '../ai/researchFlow';
import type { ResearchMetric } from '../eval/Run4Panel';
import { run4Provenance } from '../eval/run4Provenance';

const emptySnapshot = (): Snapshot => ({ paragraphs: [], items: [], profile: [], jobs: [] });
export function StorageNotice({ notice }: { notice: string }) {
  return notice ? <p role="alert">{notice}</p> : null;
}
const DevSessionPlayer = import.meta.env.DEV ? lazy(() => import('../eval/SessionPlayerPanel')) : null;
const Run4Panel = import.meta.env.DEV ? lazy(() => import('../eval/Run4Panel').then(module =>
  ({ default: module.Run4Panel }))) : null;
export default function App({ developerPlayer = false }: { developerPlayer?: boolean } = {}) {
  const service = useMemo(createService, []);
  const [, refresh] = useState(0);
  const [page, setPage] = useState('Notebook');
  const [text, setText] = useState('');
  const [storageStatus, setStorageStatus] = useState<'loading' | 'saving' | 'saved' | 'error'>('loading');
  const [storageNotice, setStorageNotice] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [research, setResearch] = useState<Record<string, ResearchView>>({});
  const [cloudConsent, setCloudConsent] = useState(false);
  const cloudConsentRef = useRef(false);
  const [researchMetrics, setResearchMetrics] = useState<ResearchMetric[]>([]);
  const inFlight = useRef(new Set<string>());
  const storageStatusRef = useRef(storageStatus);
  storageStatusRef.current = storageStatus;
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
    let outdated = false;
    const update = () => {
      if (!opened) return;
      void opened.snapshot().then(value => {
        if (mounted.current) { snapshotRef.current = value; setSnapshot(value); }
      })
        .catch(() => { if (mounted.current) setStorageStatus('error'); });
    };
    void (async () => {
      try {
        opened = await openLocalStore(undefined, {
          onBlocked: () => {
            if (mounted.current) setStorageNotice(STORAGE_BLOCKED_NOTICE);
          },
          onVersionChange: () => {
            outdated = true; scheduler?.stop(); schedulerRef.current = null; storeRef.current = null;
            if (mounted.current) {
              setStorageNotice(STORAGE_OUTDATED_NOTICE); setStorageStatus('error');
            }
          },
        });
        if (!mounted.current || outdated) { opened.close(); return; }
        await opened.migrate(localStorage);
        const consent = await opened.cloudConsent();
        const initial = await opened.snapshot();
        if (!mounted.current || outdated) { opened.close(); return; }
        setStorageNotice('');
        cloudConsentRef.current = consent; setCloudConsent(consent);
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
      cloudConsentRef.current = false; setCloudConsent(false); setResearch({}); setResearchMetrics([]);
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
  const researchQuestion = async (id: string) => {
    const store = storeRef.current;
    if (!config || !store) throw new Error('Firebase or local storage is unavailable.');
    if (!settingsRef.current.values.cloud_enabled) throw new Error('Cloud research is currently disabled.');
    if (inFlight.current.has(id)) throw new Error('Research is already in progress for this question.');
    inFlight.current.add(id);
    try {
      if (!await store.cloudConsent()) {
        const entry = (await store.snapshot()).outbox?.find(value => value.id === id && value.status === 'approved');
        if (!entry) throw new Error('Approve this question before researching it.');
        if (!window.confirm("This question, and nothing else from your notebook or profile, goes to " +
            `Google's Gemini API with Google Search:\n\n${entry.question}\n\nContinue?`)) return;
        await store.setCloudConsent(true);
      }
      cloudConsentRef.current = true; setCloudConsent(true);
      const initialRevision = revision.current;
      const settings = settingsRef.current;
      const budget = settings.values.daily_cloud_budget;
      const provenance = run4Provenance(settings, settings.values.cloud_model);
      let attemptId = '';
      const view = await researchApproved(store, createCloudAdapter(config), id,
        provenance.model, { budget, enabled: settings.values.cloud_enabled,
          canSend: () => storageStatusRef.current === 'saved' && revision.current === initialRevision &&
            settingsRef.current.values.cloud_enabled && settingsRef.current.values.daily_cloud_budget >= budget &&
            cloudConsentRef.current && storeRef.current === store,
          planUnchanged: () => storageStatusRef.current === 'saved' && revision.current === initialRevision,
          onAttempt: () => {
            const thisId = crypto.randomUUID();
            attemptId = thisId;
            setResearchMetrics(current => [...current, { id: thisId, questionId: id, latencyMs: null,
              sourceCount: null, suggestionsPresent: null, inCloud: null, grounded: null, displayed: false,
              provenance: run4Provenance(provenance.settings, provenance.model) }]);
          },
          onResponse: measurement => {
            const measuredId = attemptId;
            setResearchMetrics(current => current.map(row => row.id === measuredId ? { ...row, ...measurement } : row));
          } });
      const completedId = attemptId;
      setResearchMetrics(current => current.map(row => row.id === completedId ? { ...row, displayed: true } : row));
      setResearch(current => ({ ...current, [id]: view }));
      await refreshData();
      setPage('Notebook');
    } finally { inFlight.current.delete(id); }
  };
  return (
    <div className="app">
      <header className="header"><div><div className="eyebrow">A quieter way to think</div><h1>ThoughtPartner</h1></div>
        <nav aria-label="Main navigation">{['Notebook', 'Profile', 'Outbox', 'Insights'].map(item => (
          <button key={item} aria-current={page === item ? 'page' : undefined} onClick={() => setPage(item)}>
            {item}
          </button>))}</nav></header>
      <Notices configured={config !== null} state={service.state} />
      <StorageNotice notice={storageNotice} />
      <main>{page === 'Notebook' ? <NotebookPanel text={text} save={save} storageStatus={storageStatus}
        snapshot={snapshot} configured={config !== null} ready={service.state.kind === 'ready'} research={research}
        researchAgain={researchQuestion}
        feedback={(cardId, value) => {
          void changeProfile(async store => { await store.setFeedback(cardId, value); })
            .catch(() => setStorageStatus('error'));
        }} /> :
        page === 'Profile' ? <ProfilePanel records={snapshot.profile}
          save={(record: ProfileRecord) => changeProfile(store => store.putProfile(record))}
          remove={id => changeProfile(store => store.deleteProfile(id))}
          replace={(records, terms) => changeProfile(store => store.replaceProfile(records, terms))}
          neverSend={snapshot.neverSend ?? []}
          saveNeverSend={terms => changeProfile(store => store.putNeverSend(terms))} clearAll={clearAll}
          cloudConsent={cloudConsent} revokeCloudConsent={async () => {
            const store = storeRef.current;
            if (!store) throw new Error('Local storage unavailable.');
            await store.setCloudConsent(false); cloudConsentRef.current = false; setCloudConsent(false);
          }} /> :
          page === 'Outbox' ? <OutboxPage entries={snapshot.outbox ?? []} snapshot={snapshot}
            saving={storageStatus !== 'saved'} research={researchQuestion} decide={async (id, value) => {
            const store = storeRef.current;
            if (!store) throw new Error('Local storage unavailable.');
            const result = await store.decideOutbox(id, value);
            await refreshData();
            return result;
          }} remove={id => changeProfile(store => store.deleteOutbox(id))} /> :
          <section className="panel"><h2>Insights</h2><p>Research sends this session: {researchMetrics.length}</p>
            <p>Responses: {researchMetrics.filter(row => row.latencyMs !== null).length} · Sources returned: {
              researchMetrics.reduce((total, row) => total + (row.sourceCount ?? 0), 0)} · Suggestions returned: {
              researchMetrics.filter(row => row.suggestionsPresent).length}</p>
            <p>Research latency (ms): {researchMetrics.flatMap(row => row.latencyMs === null ? [] : [row.latencyMs])
              .join(', ') || 'No responses yet'}. Counts reset on reload.</p></section>}
        {developerPlayer && Run4Panel && <Suspense fallback={<p>Loading research metrics…</p>}>
          <Run4Panel research={research} metrics={researchMetrics} /></Suspense>}
        {developerPlayer && DevSessionPlayer && <Suspense fallback={<p>Loading rehearsal player…</p>}>
          <DevSessionPlayer text={text} save={save} snapshot={snapshot} storageStatus={storageStatus}
            readTerms={() => snapshotRef.current.neverSend ?? []}
            writeTerms={terms => changeProfile(store => store.putNeverSend(terms))}
            writeProfile={records => changeProfile(store => store.replaceProfile(records))}
            readFunnel={() => {
              if (!storeRef.current) throw new Error('Local storage unavailable.');
              return storeRef.current.funnel();
            }} />
        </Suspense>}</main>
      <StatusBar service={service} configured={config !== null} foreground={foreground} settings={settings} />
    </div>
  );
}
