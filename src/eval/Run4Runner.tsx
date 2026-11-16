import { useEffect, useRef, useState } from 'react';
import questions from '../../eval/run4-questions.json';
import { createCloudAdapter, isGrounded } from '../ai/cloudResearch';
import type { ResearchView } from '../ai/researchFlow';
import { loadSettings } from '../settings/remoteSettings';
import { openLocalStore, type LocalStore } from '../store';
import { ResearchBlock } from '../ui/ResearchBlock';
import { config } from '../ui/service';
import { Run4Panel, type ResearchMetric } from './Run4Panel';
import { sendRun4Question, validateRun4Questions } from './run4Cloud';
import { run4Provenance } from './run4Provenance';

export function Run4Runner() {
  const [store, setStore] = useState<LocalStore | null>(null);
  const activeRef = useRef(true);
  const [views, setViews] = useState<Record<string, ResearchView>>({});
  const [metrics, setMetrics] = useState<ResearchMetric[]>([]);
  const [message, setMessage] = useState('');
  const [running, setRunning] = useState(false);
  const busy = useRef(false);
  useEffect(() => {
    let active = true;
    activeRef.current = true;
    let opened: LocalStore | null = null;
    void openLocalStore(undefined, { onVersionChange: () => { if (active) setStore(null); } }).then(value => {
      opened = value;
      if (active) setStore(value); else value.close();
    }).catch(() => { if (active) setMessage('Local storage is unavailable.'); });
    return () => { active = false; activeRef.current = false; opened?.close(); };
  }, []);
  const items = validateRun4Questions(questions);
  const run = async (item: typeof items[number]) => {
    if (busy.current || !store || !config) return;
    busy.current = true; setRunning(true); setMessage('');
    try {
      const settings = await loadSettings(config);
      if (!activeRef.current) return;
      if (!settings.values.cloud_enabled) throw new Error('Cloud research is currently disabled.');
      if (!await store.cloudConsent()) {
        if (!window.confirm("This question, and nothing else from your notebook or profile, goes to " +
            `Google's Gemini API with Google Search:\n\n${item.question}\n\nContinue?`)) return;
        await store.setCloudConsent(true);
      }
      const budget = settings.values.daily_cloud_budget;
      const provenance = run4Provenance(settings, settings.values.cloud_model);
      let attemptId = '';
      const view = await sendRun4Question(store, createCloudAdapter(config), item,
        provenance.model, { enabled: settings.values.cloud_enabled, budget,
          canSend: () => activeRef.current,
          onAttempt: () => {
            const id = crypto.randomUUID(); attemptId = id;
            setMetrics(current => [...current, { id, questionId: item.id, latencyMs: null, sourceCount: null,
              suggestionsPresent: null, inCloud: null, grounded: null, displayed: false,
              provenance: run4Provenance(provenance.settings, provenance.model) }]);
          },
          onResponse: measurement => {
            const id = attemptId;
            setMetrics(current => current.map(row => row.id === id ? { ...row, ...measurement } : row));
          } });
      const id = attemptId;
      setMetrics(current => current.map(row => row.id === id ? { ...row, displayed: true } : row));
      setViews(current => ({ ...current, [item.id]: view }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Research could not be completed.');
    } finally { busy.current = false; setRunning(false); }
  };
  return <section className="panel"><h2>Run 4 · approved frozen questions</h2>
    <p>Review each question and click Research to approve sending it. Results stay in this page's memory.</p>
    {!config && <p>Firebase is not configured.</p>}
    {message && <p role="alert">{message}</p>}
    {items.map(item => <article className="item-card" key={item.id}>
      <p>{item.id} · Profile {item.profile}</p><p>{item.question}</p>
      <button disabled={!store || !config || running} onClick={() => { void run(item); }}>Research</button>
      {views[item.id] && <section><h4>What the research found</h4>
        {!isGrounded(views[item.id].result) && <p>This answer used no web sources.</p>}
        {views[item.id].changedAfterSend && <p role="status">Your consent or never-send list changed after sending.</p>}
        <ResearchBlock result={views[item.id].result} />
      </section>}
    </article>)}
    <Run4Panel research={views} metrics={metrics} />
  </section>;
}
