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
import { CloudProcessingService, createProcessingAdapter } from '../ai/cloudProcessing';
import { modeRouter } from './modeRouter';

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
  const [cloudMode, setCloudMode] = useState(false);
  const renderedModeRef = useRef(false);
  renderedModeRef.current = cloudMode;
  const cloudModeRef = useRef(false);
  const cloudServiceRef = useRef<CloudProcessingService | null>(null);
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
  const refreshSeq = useRef(0);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const foreground = useForeground();
  const reconcile = (next: Snapshot) => {
    const selected = next.cloudModeEnabled === true;
    if (selected !== cloudModeRef.current) {
      cloudModeRef.current = selected;
      schedulerRef.current?.modeChanged();
      setCloudMode(selected);
    }
    snapshotRef.current = next;
    setSnapshot(next);
  };
  const refreshData = async () => {
    const store = storeRef.current;
    if (!store) throw new Error('Local storage unavailable.');
    const sequence = ++refreshSeq.current;
    const next = await store.snapshot();
    if (mounted.current && storeRef.current === store && sequence === refreshSeq.current) reconcile(next);
  };
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
      if (!opened || !storeRef.current) return;
      void refreshData().catch(() => { if (mounted.current) setStorageStatus('error'); });
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
        reconcile(initial);
        setText(initial.paragraphs.map(p => p.text).join('\n\n'));
        setStorageStatus('saved');
        const cloud = config ? new CloudProcessingService(opened, createProcessingAdapter(config),
          () => settingsRef.current.values.cloud_enabled,
          () => settingsRef.current.values.cloud_model, update, Date.now,
          () => document.visibilityState === 'visible') : null;
        cloudServiceRef.current = cloud;
        const pipeline = modeRouter(service, cloud, () => opened!.cloudModeConsent(),
          () => settingsRef.current.values.cloud_enabled, () => document.visibilityState === 'visible',
          mode => renderedModeRef.current === mode);
        scheduler = new Scheduler(opened, pipeline,
          () => settingsRef.current.values.prompt_set === 'v1' ? 'extract.v1' : 'extract.v2', update,
          Date.now, () => { if (mounted.current) setStorageStatus('error'); });
        schedulerRef.current = scheduler;
        await scheduler.start();
      } catch {
        if (mounted.current) setStorageStatus('error');
      }
    })();
    return () => { mounted.current = false; scheduler?.stop(); schedulerRef.current = null;
      storeRef.current = null; cloudServiceRef.current = null; opened?.close(); };
  }, [service]);
  useEffect(() => {
    let channel: BroadcastChannel | null = null;
    try {
      channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('thoughtpartner-cloud-mode');
      channelRef.current = channel;
      if (channel) channel.onmessage = () => {
        if (storeRef.current) void refreshData().catch(() => setStorageStatus('error'));
      };
    } catch { channelRef.current = null; }
    const sync = () => {
      if (storeRef.current) void refreshData().then(() => {
        if (document.visibilityState === 'visible') void schedulerRef.current?.tick();
      }).catch(() => setStorageStatus('error'));
    };
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      window.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', sync);
      channel?.close(); channelRef.current = null;
    };
  }, []);
  const announceMode = () => {
    try { channelRef.current?.postMessage('mode-changed'); } catch { /* Focus resyncs. */ }
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
      cloudConsentRef.current = false; setCloudConsent(false);
      announceMode();
      setResearch({}); setResearchMetrics([]);
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
  const enableCloudMode = async () => {
    const store = storeRef.current;
    if (!store || !config || !settingsRef.current.values.cloud_enabled) {
      throw new Error('Cloud mode is unavailable.');
    }
    if (!window.confirm("In cloud mode, the parts of your plan that ThoughtPartner works on are sent to " +
      "Google's Gemini API (through Firebase AI Logic): each paragraph you write, the earlier wording of a " +
      'statement when it checks what changed, and the statements and concerns it derives from them to write ' +
      'questions. Your profile and your never-send list are not sent.')) return;
    schedulerRef.current?.modeChanged();
    await store.setCloudModeConsent(true);
    announceMode();
    await refreshData();
    void schedulerRef.current?.tick();
  };
  const disableCloudMode = async () => {
    const store = storeRef.current;
    if (!store) throw new Error('Local storage unavailable.');
    schedulerRef.current?.modeChanged();
    await store.setCloudModeConsent(false);
    announceMode();
    await store.finalizeReady();
    await refreshData();
    void schedulerRef.current?.tick();
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
      <Notices configured={config !== null} state={service.state} cloudMode={cloudMode}
        cloudEnabled={settings.values.cloud_enabled} chooseCloud={() => {
          void enableCloudMode().catch(() => setStorageNotice('Could not enable cloud mode.'));
        }} />
      <StorageNotice notice={storageNotice} />
      <main>{page === 'Notebook' ? <NotebookPanel text={text} save={save} storageStatus={storageStatus}
        snapshot={snapshot} configured={config !== null}
        ready={cloudMode ? settings.values.cloud_enabled : service.state.kind === 'ready'} cloudMode={cloudMode}
        research={research} researchAgain={researchQuestion}
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
          cloudMode={cloudMode} revokeCloudMode={disableCloudMode}
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
      <StatusBar service={service} configured={config !== null} foreground={foreground} settings={settings}
        cloudMode={cloudMode} cloudMessage={!settings.values.cloud_enabled && cloudMode
          ? 'Cloud processing is disabled; queued cloud jobs are paused.' : cloudServiceRef.current?.message ?? ''} />
    </div>
  );
}
