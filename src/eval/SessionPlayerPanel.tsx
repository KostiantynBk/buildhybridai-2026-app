import { useEffect, useState } from 'react';
import type { ProfileRecord, Snapshot } from '../store';
import type { FunnelEvent } from '../store/triageTypes';
import { triagePromptVersions } from '../pipeline/triageVersion';
import { applySessionEdit, buildSessionStepLog, nextSessionEdit, prepareSessionStart, removeSessionTerms,
  sessionForPlay, type SessionTerms } from './sessionPlayer';

type Profile = 'A' | 'B' | 'own';
type Props = { text: string; save: (text: string) => void; snapshot: Snapshot; storageStatus: string;
  readTerms: () => string[]; writeTerms: (terms: string[]) => Promise<void>;
  writeProfile: (records: ProfileRecord[]) => Promise<void>; readFunnel: () => Promise<FunnelEvent[]> };
type StepLog = { step: number; startedAt: number; finishedAt: number; elapsedMs: number; timedOut: boolean;
  paragraphs: unknown[];
  items: unknown[]; cards: unknown[]; outbox: unknown[]; funnel: unknown[]; jobs: unknown[] };
export default function SessionPlayer({ text, save, snapshot, storageStatus, readTerms, writeTerms,
  writeProfile, readFunnel }: Props) {
  const session = sessionForPlay('S1');
  const [profile, setProfile] = useState<Profile>('A');
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [terms, setTerms] = useState<SessionTerms | null>(null);
  const [stepNumber, setStepNumber] = useState(1);
  const [blocks, setBlocks] = useState<Record<number, string>>({});
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [baseline, setBaseline] = useState<Snapshot | null>(null);
  const [baselineEvents, setBaselineEvents] = useState<string[]>([]);
  const [recording, setRecording] = useState(false);
  const [logs, setLogs] = useState<StepLog[]>([]);
  const [message, setMessage] = useState('');
  const [clock, setClock] = useState(Date.now());
  const [lastChange, setLastChange] = useState(Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const timer = window.setInterval(() => setClock(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const progressSignature = JSON.stringify({ paragraphs: snapshot.paragraphs, items: snapshot.items,
    jobs: snapshot.jobs, cards: snapshot.cards, outbox: snapshot.outbox });
  useEffect(() => { if (startedAt) setLastChange(Date.now()); }, [progressSignature, storageStatus, startedAt]);
  const step = session.steps.find(value => value.n === stepNumber);
  const pending = snapshot.jobs.some(job => job.status === 'pending' || job.status === 'running');
  const timeout = startedAt !== null && clock - startedAt >= 60000;
  const settled = startedAt !== null && clock - startedAt >= 4000 && clock - lastChange >= 2000 &&
    storageStatus === 'saved' && !pending;
  async function begin() {
    if (text.trim()) { setMessage('Start with an empty notebook. Existing content was not changed.'); return; }
    try {
      const added = await prepareSessionStart(profile, snapshot.profile, readTerms(), session.privateTokens,
        message => window.confirm(message), writeTerms, writeProfile);
      if (added) {
        setTerms(added); setPlaying(true);
        if (added.profileError) {
          setEnded(true); setMessage('Profile replacement failed. You can remove the added test terms below.');
        } else setMessage('S1 ready. Add each step, wait, then record it.');
      }
    } catch (error) {
      setMessage(error instanceof Error && error.message === 'The list exceeds 200 terms.'
        ? 'Cannot start: the Never send list would exceed 200 terms.'
        : 'Could not prepare the local profile and privacy list. Check your list before retrying.');
    }
  }
  async function applyStep() {
    setRecording(true);
    try {
      const next = nextSessionEdit('S1', stepNumber, text, blocks);
      const events = await readFunnel();
      setBaselineEvents(events.map(event => event.id));
      setBaseline(snapshot); setStartedAt(Date.now()); setLastChange(Date.now()); setClock(Date.now());
      setBlocks(next.blocks); applySessionEdit(next, save);
      setMessage('Waiting for local processing; give feedback after settling.');
    } catch { setMessage('Could not prepare the step; no edit was made. Check the original paragraph.'); }
    finally { setRecording(false); }
  }
  async function recordStep() {
    if (!startedAt || !baseline || (!settled && !timeout)) return;
    setRecording(true);
    let latestEvents: FunnelEvent[];
    try { latestEvents = await readFunnel(); } catch {
      setRecording(false); setMessage('Could not read the local funnel; the step was not recorded.'); return;
    }
    const log = buildSessionStepLog(stepNumber, startedAt, Date.now(), timeout && !settled,
      baseline, snapshot, baselineEvents, latestEvents);
    setLogs(previous => [...previous, log]); setStartedAt(null); setBaseline(null);
    setRecording(false); setStepNumber(value => value + 1);
    setMessage(timeout && !settled ? 'Step recorded at the 60-second limit.' :
      'Step recorded. Continue when ready.');
  }
  function download() {
    const report = { mode: 'S1-rehearsal', sharing: 'local-only', profile, startedWithEmptyNotebook: true,
      neverSendTestTerms: terms,
      sourcePolicy: 'Local inference is source-checked; code shortcuts may make no model call.',
      sessionVersion: 'sessions.v1', promptVersions: triagePromptVersions(), logs };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'thoughtpartner-s1-local.json';
    link.click(); URL.revokeObjectURL(url);
  }
  return <aside className="panel" aria-label="S1 rehearsal player">
    <h2>Developer rehearsal · S1 only</h2>
    <p>Local-only log; it can contain notebook quotes and profile-derived text. Inspect before sharing.
      S2 and S3 remain held back. This is an on-device-only rehearsal: use Check this to open a card,
      but do not send questions. Give feedback after settling. No cloud research is run.</p>
    {!playing ? <><label>Profile <select value={profile} onChange={event => setProfile(event.target.value as Profile)}>
      <option value="A">Demo A</option><option value="B">Demo B</option><option value="own">Own profile</option>
    </select></label> <button disabled={storageStatus !== 'saved'} onClick={() => void begin()}>
      Start S1</button></> : <>
      {step && !ended ? <><p>Step {step.n}/7 · {step.action} · {step.title}</p><blockquote>{step.text}</blockquote>
        <button disabled={recording || startedAt !== null || storageStatus !== 'saved'}
          onClick={() => void applyStep()} >
          Apply via notebook</button>{' '}
        <button disabled={recording || !startedAt || (!settled && !timeout)} onClick={() => void recordStep()}>
          Record step</button>
        {startedAt && <p>{timeout ? '60-second limit reached.' : settled ? 'Settled; review and record.' :
          `Waiting for local work (${Math.min(60, Math.floor((clock - startedAt) / 1000))}/60 s)…`}</p>}</> :
        <p>{ended ? 'S1 cancelled.' : 'S1 complete.'} Export the local log for review.</p>}
      {step && !ended && <button disabled={recording} onClick={() => { setEnded(true); setStartedAt(null); }}>
        Cancel rehearsal</button>}{' '}
      {(ended || !step) && terms && !terms.removed && <button onClick={() => {
        void removeSessionTerms(readTerms(), terms.added, writeTerms).then(() => {
          setTerms({ ...terms, removed: true });
          setMessage('Test terms removed. Withdrawn Outbox entries remain withdrawn.');
        }).catch(() => setMessage('Could not remove the test terms. Your list was not intentionally changed.'));
      }}>Remove the {terms.added.length} terms added for this play</button>}{' '}
      {(ended || !step) && <p>Removing terms does not restore a replaced profile or withdrawn Outbox entries.</p>}
      <button disabled={logs.length === 0} onClick={download}>Export local S1 log</button>
    </>}
    {message && <p role="status">{message}</p>}
  </aside>;
}
