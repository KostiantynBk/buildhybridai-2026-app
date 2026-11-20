import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { builtInSettings } from '../settings/defaults';
import { loadSettings } from '../settings/remoteSettings';
import { openLocalStore, SampleChangedError, type LocalStore, type ProfileRecord, type Snapshot } from '../store';
import { Scheduler } from '../store/scheduler';
import { ProfilePanel } from '../profile/ProfilePanel';
import { config, createService, startReadiness, useForeground } from './service';
import { NotebookPanel } from './NotebookPanel';
import { OutboxPage } from './OutboxPage';
import { Notices } from './Notices';
import { StatusBar } from './StatusBar';
import { STORAGE_BLOCKED_NOTICE, STORAGE_OUTDATED_NOTICE } from './storageNotices';
import { createCloudAdapter, IDEA_RESEARCH } from '../ai/cloudResearch';
import { researchApproved, researchIdea, UngroundedIdeaError, type ResearchView } from '../ai/researchFlow';
import { IdeaPanel } from './IdeaPanel';
import { safeResearchErrorMessage } from '../ai/researchFailure';
import type { ResearchMetric } from '../eval/Run4Panel';
import { run4Provenance } from '../eval/run4Provenance';
import { CloudProcessingService, createProcessingAdapter } from '../ai/cloudProcessing';
import { modeRouter } from './modeRouter';
import { Welcome } from './Welcome';
import { samplePlan } from './samplePlan';
import { copy } from './copy';
import { navigationItems } from './navigation';

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
  const textRef = useRef('');
  const [sampleActive, setSampleActive] = useState(false);
  const sampleIds = useRef<string[]>([]);
  const displayedParagraphs = useRef<Snapshot['paragraphs']>([]);
  const [welcomeVisible, setWelcomeVisible] = useState(() => {
    try { return localStorage.getItem('tp.welcomeSeen') !== 'true'; } catch { return true; }
  });
  const [storageStatus, setStorageStatus] = useState<'loading' | 'saving' | 'saved' | 'error'>('loading');
  const [storageNotice, setStorageNotice] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [research, setResearch] = useState<Record<string, ResearchView>>({});
  const [ideaResearch, setIdeaResearch] = useState<Record<string, ResearchView>>({});
  const [researchErrors, setResearchErrors] = useState<Record<string, string>>({});
  const [researchPhase, setResearchPhase] = useState<Record<string, 'checking' | 'searching' | undefined>>({});
  const searching = Object.fromEntries(Object.entries(researchPhase)
    .map(([key, value]) => [key, value === 'searching']));
  const checking = Object.fromEntries(Object.entries(researchPhase).map(([key, value]) => [key, value === 'checking']));
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
        const initialText = initial.paragraphs.map(p => p.text).join('\n\n');
        textRef.current = initialText; setText(initialText); displayedParagraphs.current = initial.paragraphs;
        try {
          const ids: unknown = JSON.parse(localStorage.getItem('tp.sampleIds') ?? '[]');
          sampleIds.current = Array.isArray(ids) && ids.every(value => typeof value === 'string') ? ids : [];
          setSampleActive(!!initialText && sampleIds.current.length > 0 &&
            initial.paragraphs.length === sampleIds.current.length &&
            initial.paragraphs.every(p => sampleIds.current.includes(p.id)));
        } catch { /* Local only. */ }
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
    textRef.current = value; setText(value);
    if (!value.trim()) {
      setSampleActive(false); sampleIds.current = [];
      try { localStorage.removeItem('tp.sampleActive'); localStorage.removeItem('tp.sampleIds'); }
      catch { /* Local only. */ }
    }
    const sequence = ++revision.current;
    schedulerRef.current?.edited(value, snapshotRef.current.paragraphs);
    storageStatusRef.current = 'saving'; setStorageStatus('saving');
    writes.current = writes.current.catch(() => undefined).then(async () => {
      const store = storeRef.current;
      if (!store) throw new Error('Local storage unavailable.');
      const saved = await store.saveNotebook(value);
      await refreshData();
      if (sequence === revision.current && mounted.current) {
        displayedParagraphs.current = saved;
        if (sampleIds.current.length && (saved.length !== sampleIds.current.length ||
          saved.some(p => !sampleIds.current.includes(p.id)))) setSampleActive(false);
        storageStatusRef.current = 'saved'; setStorageStatus('saved'); schedulerRef.current?.saved();
      }
    }).catch(() => {
      if (mounted.current) { storageStatusRef.current = 'error'; setStorageStatus('error'); }
    });
  };
  const dismissWelcome = () => {
    try { localStorage.setItem('tp.welcomeSeen', 'true'); } catch { /* Dismiss for this session. */ }
    setWelcomeVisible(false);
  };
  const loadSample = async (paragraphs: readonly string[]) => {
    const store = storeRef.current;
    if (!store || storageStatusRef.current !== 'saved' || textRef.current.trim()) {
      throw new Error('The sample is available only when the notebook is empty.');
    }
    const sequence = ++revision.current;
    schedulerRef.current?.edited();
    storageStatusRef.current = 'saving'; setStorageStatus('saving');
    let unchanged = false;
    try {
      const value = paragraphs.join('\n\n');
      let inserted: Snapshot['paragraphs'] = [];
      const loaded = await store.loadSampleIfEmpty(value, Date.now(), value => { inserted = value; });
      if (!loaded) { unchanged = true; throw new Error('The notebook is no longer empty.'); }
      if (sequence === revision.current && mounted.current) {
        textRef.current = value; setText(value);
        await refreshData();
        if (sequence !== revision.current || !mounted.current) return;
        displayedParagraphs.current = inserted;
        sampleIds.current = inserted.map(p => p.id);
        setSampleActive(true);
        try {
          localStorage.setItem('tp.sampleActive', 'true');
          localStorage.setItem('tp.sampleIds', JSON.stringify(sampleIds.current));
        } catch { /* Local only. */ }
        storageStatusRef.current = 'saved'; setStorageStatus('saved'); schedulerRef.current?.saved();
        dismissWelcome();
      }
    } catch (error) {
      if (sequence === revision.current && mounted.current) {
        storageStatusRef.current = unchanged ? 'saved' : 'error';
        setStorageStatus(unchanged ? 'saved' : 'error');
        if (unchanged) schedulerRef.current?.saved();
      }
      throw error;
    }
  };
  const removeSample = async () => {
    if (!window.confirm('Remove the sample? This clears the entire notebook, including your edits.')) return;
    const store = storeRef.current;
    const expected = displayedParagraphs.current.map(({ id, version }) => ({ id, version }));
    if (!store || storageStatusRef.current !== 'saved' || !expected.length ||
        expected.length !== sampleIds.current.length || expected.some(p => !sampleIds.current.includes(p.id))) {
      setStorageNotice('Your notebook changed, so nothing was removed.'); return;
    }
    const sequence = ++revision.current;
    schedulerRef.current?.edited();
    storageStatusRef.current = 'saving'; setStorageStatus('saving');
    try {
      await store.saveNotebook('', Date.now(), expected);
      const next = await store.snapshot();
      if (sequence === revision.current && mounted.current) {
        reconcile(next); textRef.current = ''; setText(''); displayedParagraphs.current = [];
        sampleIds.current = []; setSampleActive(false);
        try { localStorage.removeItem('tp.sampleActive'); localStorage.removeItem('tp.sampleIds'); }
        catch { /* Local only. */ }
        setStorageNotice(''); storageStatusRef.current = 'saved'; setStorageStatus('saved');
        schedulerRef.current?.saved();
      }
    } catch (error) {
      if (sequence !== revision.current || !mounted.current) return;
      if (error instanceof SampleChangedError) {
        try {
          const next = await store.snapshot();
          if (sequence !== revision.current || !mounted.current) return;
          reconcile(next); displayedParagraphs.current = next.paragraphs;
          const value = next.paragraphs.map(p => p.text).join('\n\n');
          textRef.current = value; setText(value); sampleIds.current = []; setSampleActive(false);
          setStorageNotice(error.message); storageStatusRef.current = 'saved'; setStorageStatus('saved');
          schedulerRef.current?.saved();
        } catch { storageStatusRef.current = 'error'; setStorageStatus('error'); }
      } else { storageStatusRef.current = 'error'; setStorageStatus('error'); }
    }
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
    storageStatusRef.current = 'saving'; setStorageStatus('saving');
    try {
      await writes.current;
      const store = storeRef.current;
      if (!store) throw new Error('Local storage unavailable.');
      await store.clearAll(localStorage);
      cloudConsentRef.current = false; setCloudConsent(false);
      announceMode();
      setResearch({}); setIdeaResearch({}); setResearchErrors({}); setResearchPhase({}); setResearchMetrics([]);
      textRef.current = ''; setText(''); setSampleActive(false);
      try { localStorage.removeItem('tp.sampleActive'); } catch { /* Local only. */ }
      await refreshData();
      storageStatusRef.current = 'saved'; setStorageStatus('saved');
      schedulerRef.current?.saved();
    } catch {
      storageStatusRef.current = 'error'; setStorageStatus('error');
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
      'statement when it checks what changed, and the statements and concerns it derives from them, to write ' +
      'questions and a short description of your idea. Your profile and your never-send list are not sent.')) return;
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
    if (inFlight.current.has(id)) throw new Error('Research is already in progress for this question.');
    inFlight.current.add(id);
    setResearchPhase(current => ({ ...current, [id]: 'checking' }));
    let attempted = false;
    try {
      if (!config || !store) throw new Error('Firebase or local storage is unavailable.');
      if (!settingsRef.current.values.cloud_enabled) throw new Error('Cloud research is currently disabled.');
      if (!await store.cloudConsent()) {
        const entry = (await store.snapshot()).outbox?.find(value => value.id === id && value.status === 'approved');
        if (!entry) throw new Error('Approve this question before researching it.');
        if (!window.confirm("This question, and nothing else from your notebook or profile, goes to " +
            `Google's Gemini API with Google Search:\n\n${entry.question}\n\nContinue?`)) {
          throw new Error('Research consent was not granted.');
        }
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
            attempted = true; setResearchPhase(current => ({ ...current, [id]: 'searching' }));
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
      setResearchErrors(current => ({ ...current, [id]: '' }));
      await refreshData();
      setPage('Notebook');
    } catch (error) {
      const reason = safeResearchErrorMessage(error);
      try { if (store && storeRef.current === store) await refreshData(); } catch { /* Preserve the original error. */ }
      const message = `${attempted ? 'Sent, but the search failed' : 'Approved, not sent'}: ${reason}`;
      setResearchErrors(current => ({ ...current, [id]: message }));
      throw new Error(message);
    } finally {
      inFlight.current.delete(id); setResearchPhase(current => ({ ...current, [id]: undefined }));
    }
  };
  const researchIdeaAction = async (ideaId: string) => {
    const key = `idea:${ideaId}`;
    if (inFlight.current.has(key)) throw new Error('Research is already in progress for this idea.');
    inFlight.current.add(key);
    setResearchPhase(current => ({ ...current, [key]: 'checking' }));
    const store = storeRef.current;
    let attempted = false;
    try {
      if (!config || !store) throw new Error('Firebase or local storage is unavailable.');
      if (!settingsRef.current.values.cloud_enabled) throw new Error('Cloud research is currently disabled.');
      const idea = (await store.snapshot()).ideas?.find(value => value.id === ideaId);
      if (!idea?.finalText) throw new Error('Approve this description before researching it.');
      if (!await store.cloudConsent()) {
        if (!window.confirm("This description, and nothing else from your notebook or profile, goes to " +
            `Google's Gemini API with Google Search:\n\n${idea.finalText}\n\nContinue?`)) {
          throw new Error('Research consent was not granted.');
        }
        await store.setCloudConsent(true);
      }
      cloudConsentRef.current = true; setCloudConsent(true);
      const initialRevision = revision.current;
      const settings = settingsRef.current;
      const view = await researchIdea(store, createCloudAdapter(config, IDEA_RESEARCH), ideaId,
        settings.values.cloud_model, { enabled: settings.values.cloud_enabled,
          budget: settings.values.daily_cloud_budget,
          canSend: () => document.visibilityState === 'visible' && storageStatusRef.current === 'saved' &&
            revision.current === initialRevision && cloudConsentRef.current && storeRef.current === store &&
            settingsRef.current.values.cloud_enabled &&
            settingsRef.current.values.daily_cloud_budget >= settings.values.daily_cloud_budget,
          planUnchanged: () => storageStatusRef.current === 'saved' && revision.current === initialRevision,
          onAttempt: () => {
            attempted = true; setResearchPhase(current => ({ ...current, [key]: 'searching' }));
            void refreshData().catch(() => { storageStatusRef.current = 'error'; setStorageStatus('error'); });
          } });
      setIdeaResearch(current => ({ ...current, [ideaId]: view }));
      try { await store.finishIdeaResearch(ideaId, 'sent'); await refreshData(); } catch {
        storageStatusRef.current = 'error'; setStorageStatus('error');
      }
    } catch (error) {
      if (error instanceof UngroundedIdeaError && store) {
        setIdeaResearch(current => { const next = { ...current }; delete next[ideaId]; return next; });
        let phaseFailed = false;
        try { await store.finishIdeaResearch(ideaId, 'sent'); } catch { phaseFailed = true; }
        try { await refreshData(); } catch { phaseFailed = true; }
        if (phaseFailed) {
          setStorageNotice('Research completed, but the local status could not be updated.');
          storageStatusRef.current = 'error'; setStorageStatus('error');
        }
        return;
      }
      if (attempted && store) await store.finishIdeaResearch(ideaId, 'failed').catch(() => undefined);
      try { if (store && storeRef.current === store) await refreshData(); } catch { /* Keep original error. */ }
      throw new Error(`${attempted ? 'Sent, but the search failed' : 'Approved, not sent'}: ` +
        safeResearchErrorMessage(error));
    } finally {
      inFlight.current.delete(key); setResearchPhase(current => ({ ...current, [key]: undefined }));
    }
  };
  const latestIdea = [...(snapshot.ideas ?? [])].sort((a, b) => b.createdAt - a.createdAt ||
    b.id.localeCompare(a.id))[0];
  return (
    <div className="app">
      <header className="header"><div><div className="eyebrow">{copy.tagline}</div><h1>ThoughtPartner</h1></div>
        <nav aria-label="Main navigation">{navigationItems(import.meta.env.DEV).map(item => (
          <button key={item} aria-current={page === item ? 'page' : undefined} onClick={() => setPage(item)}>
            {item}
          </button>))}</nav></header>
      <Notices configured={config !== null} state={service.state} cloudMode={cloudMode}
        cloudEnabled={settings.values.cloud_enabled} chooseCloud={() => {
          void enableCloudMode().catch(() => setStorageNotice('Could not enable cloud mode.'));
        }} />
      <StorageNotice notice={storageNotice} />
      <main>{welcomeVisible && <Welcome state={service.state} browserAvailability={service.browserAvailability}
        configured={config !== null} foreground={foreground}
        preparing={service.preparing} cloudMode={cloudMode} cloudEnabled={settings.values.cloud_enabled}
        chooseCloud={() => { void enableCloudMode().catch(() => setStorageNotice('Could not enable cloud mode.')); }}
        download={() => { void service.prepare().catch(() => undefined); }}
        checkAgain={() => { void service.probe().catch(() => undefined); }}
        sampleAvailable={storageStatus === 'saved' && !text.trim()} trySample={() => {
          void loadSample(samplePlan).catch(error => setStorageNotice(error instanceof Error
            ? error.message : 'Could not load the sample.'));
        }} startBlank={dismissWelcome} />}
      {page === 'Notebook' ? <><IdeaPanel snapshot={snapshot} idea={latestIdea}
        view={latestIdea && ideaResearch[latestIdea.id]}
        searching={!!latestIdea && !!searching[`idea:${latestIdea.id}`]}
        checkingSend={!!latestIdea && !!checking[`idea:${latestIdea.id}`]}
        busy={storageStatus !== 'saved'} start={async () => {
          const store = storeRef.current;
          if (!store) throw new Error('Local storage unavailable.');
          if (storageStatusRef.current !== 'saved') throw new Error('Checking your latest change…');
          const result = await store.startIdea();
          if (result.reason) throw new Error(result.reason);
          await refreshData(); void schedulerRef.current?.tick();
        }} send={async (id, text) => {
          const store = storeRef.current;
          if (!store) throw new Error('Local storage unavailable.');
          if (storageStatusRef.current !== 'saved') throw new Error('Checking your latest change…');
          const result = await store.approveIdea(id, text);
          if (!result.entryId) throw new Error(result.reason ?? 'Could not approve this description.');
          await refreshData(); await researchIdeaAction(id);
        }} retry={researchIdeaAction} decline={async id => {
          const store = storeRef.current;
          if (!store || !await store.declineIdea(id)) throw new Error('Could not decline this description.');
          await refreshData();
        }} />
        <NotebookPanel text={text} save={save} storageStatus={storageStatus} sampleActive={sampleActive &&
          snapshot.paragraphs.length === sampleIds.current.length &&
          snapshot.paragraphs.every(p => sampleIds.current.includes(p.id))}
        removeSample={() => { void removeSample(); }}
        snapshot={snapshot} configured={config !== null}
        ready={cloudMode ? settings.values.cloud_enabled : service.state.kind === 'ready'}
        cloudMode={cloudMode} foreground={foreground}
        research={research} researchErrors={researchErrors} searching={searching} checkingSend={checking}
        researchAgain={researchQuestion}
        checkThis={async itemId => {
          const store = storeRef.current;
          if (!store) throw new Error('Local storage unavailable.');
          const result = await store.requestCheck(itemId);
          if (result.reason) throw new Error(result.reason);
          await refreshData(); void schedulerRef.current?.tick();
        }} sendDraft={async (cardId, text) => {
          const store = storeRef.current;
          if (!store) throw new Error('Local storage unavailable.');
          if (storageStatusRef.current !== 'saved') throw new Error('Checking your latest change…');
          const result = await store.approveDraft(cardId, text);
          if (!result.entryId) throw new Error(result.reason ?? 'Could not approve this question.');
          try { await refreshData(); } catch { throw new Error('Approved, not sent: local refresh failed.'); }
          await researchQuestion(result.entryId);
        }} declineDraft={async cardId => {
          const store = storeRef.current;
          if (!store || !await store.declineDraft(cardId)) throw new Error('Could not decline this question.');
          await refreshData();
        }} reopenDraft={async cardId => {
          const store = storeRef.current;
          if (!store || !await store.reopenDraft(cardId)) throw new Error('Could not reopen this question.');
          await refreshData();
        }} feedback={(cardId, value) => {
          void changeProfile(async store => { await store.setFeedback(cardId, value); })
            .catch(() => setStorageStatus('error'));
        }} /></> :
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
            researchErrors={researchErrors} searching={searching} checkingSend={checking}
            saving={storageStatus !== 'saved'} research={researchQuestion} decide={async (id, value) => {
            const store = storeRef.current;
            if (!store) throw new Error('Local storage unavailable.');
            const result = await store.decideOutbox(id, value);
            await refreshData();
            return result;
          }} remove={id => changeProfile(store => store.deleteOutbox(id))} /> :
          import.meta.env.DEV && <section className="panel"><h2>Insights</h2>
            <p>Research sends this session: {researchMetrics.length}</p>
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
        navigate={setPage} cloudMode={cloudMode} cloudMessage={!settings.values.cloud_enabled && cloudMode
          ? 'Cloud processing is disabled; queued cloud jobs are paused.' : cloudServiceRef.current?.message ?? ''} />
    </div>
  );
}
