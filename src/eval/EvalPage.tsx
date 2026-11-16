import { useEffect, useMemo, useState } from 'react';
import { config, createService, startReadiness, useForeground } from '../ui/service';
import { Notices } from '../ui/Notices';
import { StatusBar } from '../ui/StatusBar';
import {
  examples,
  practiceInput,
  prompts,
  promptFor,
  sizeInCharacters,
  type ProfileId,
  type PromptName,
} from './playground';
import {
  firstEvaluationAfterReload,
  markEvaluationCall,
  recordFirstEvaluation,
  runEvaluation,
  type Evaluation,
  type RunMode,
} from './runner';
import { LocalError } from '../ai/localModel';
import { hiddenNow, safeErrorName } from '../ai/errorMetadata';
import { formatFailureStatus } from './failureStatus';
import {
  canStartMeasuredRun,
  lockEvaluationIdentity,
  normalizeModelIdentity,
} from './modelIdentity';
import { useRef } from 'react';
import type { ExtractVersion } from '../pipeline/extract';
import { TRIAGE_PROMPT_SET } from '../pipeline/triageVersion';
import { runChangeEvaluation, type Run2Evaluation } from './run2';
import { runGate2, runPracticeV2, type Run3Evaluation } from './run3';

export default function EvalPage() {
  const service = useMemo(createService, []);
  const [, redraw] = useState(0);
  const [prompt, setPrompt] = useState<PromptName>('extract');
  const [example, setExample] = useState(examples[0].id);
  const [profile, setProfile] = useState<ProfileId>('A');
  const [input, setInput] = useState(() => practiceInput('extract', examples[0].id, 'A'));
  const [result, setResult] = useState('');
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState<Array<Evaluation | Run2Evaluation | Run3Evaluation>>([]);
  const [progress, setProgress] = useState('');
  const [modelIdentity, setModelIdentity] = useState('');
  const [extractVersion, setExtractVersion] = useState<ExtractVersion>('extract.v2');
  const identityLocked = lockEvaluationIdentity(running, runs.length);
  const controller = useRef<AbortController | null>(null);
  const foreground = useForeground();
  const measuredRunEnabled = canStartMeasuredRun({
    configured: config !== null,
    ready: service.state.kind === 'ready',
    running,
    foreground,
    model: modelIdentity,
  });
  const practiceReason = !config ? 'Firebase is not configured.' : !foreground ? 'Return to this tab first.' :
    running ? 'A run is already in progress.' : service.state.kind !== 'ready' ? 'Prepare the model first.' : '';
  const measuredReason = practiceReason || (!normalizeModelIdentity(modelIdentity)
    ? 'Enter the on-device model name and version.' : '');
  useEffect(() => {
    const unsubscribe = service.subscribe(() => redraw((n) => n + 1));
    const stopReadiness = startReadiness(service);
    return () => { stopReadiness(); unsubscribe(); };
  }, [service]);
  function select(nextPrompt: PromptName, nextExample: string, nextProfile: ProfileId) {
    setPrompt(nextPrompt);
    setExample(nextExample);
    setProfile(nextProfile);
    setInput(practiceInput(nextPrompt, nextExample, nextProfile));
  }
  async function run() {
    if (TRIAGE_PROMPT_SET === 'v2.1' && prompt === 'whynote') return;
    setRunning(true);
    setResult('Running locally…');
    const firstEvaluationAttemptAfterReload = markEvaluationCall();
    try {
      const definition = promptFor(prompt, extractVersion);
      const output = await service.runLocal<unknown>({
        prompt: input,
        schema: definition.schema,
        instructions: definition,
      });
      recordFirstEvaluation(firstEvaluationAttemptAfterReload, {
        latencyMs: output.latencyMs,
        source: output.source,
        error: null,
      });
      setResult(
        JSON.stringify(
          {
            rawJson: output.raw,
            latencyMs: output.latencyMs,
            source: output.source,
            inputSize: sizeInCharacters(prompt, input, extractVersion),
            promptVersion: definition.version,
            unit: 'characters',
            firstEvaluationAttemptAfterReload,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      recordFirstEvaluation(firstEvaluationAttemptAfterReload, {
        latencyMs: error instanceof LocalError ? (error.diagnostics?.latencyMs ?? null) : null,
        source: error instanceof LocalError ? (error.diagnostics?.source ?? null) : null,
        error: error instanceof LocalError ? error.code : 'local-call-failed',
      });
      setResult(
        formatFailureStatus({
          errorName:
            error instanceof LocalError
              ? (error.diagnostics?.errorName ?? safeErrorName(error))
              : safeErrorName(error),
          errorClass: error instanceof LocalError ? error.code : 'local-call-failed',
          availabilityAfter:
            error instanceof LocalError ? (error.diagnostics?.availabilityAfter ?? null) : null,
          elapsedMs: error instanceof LocalError ? (error.diagnostics?.elapsedMs ?? null) : null,
          hidden:
            error instanceof LocalError ? (error.diagnostics?.hidden ?? hiddenNow()) : hiddenNow(),
        }),
      );
    } finally {
      setRunning(false);
    }
  }
  async function startEvaluation(mode: RunMode) {
    if (!measuredRunEnabled) return;
    const current = new AbortController();
    controller.current = current;
    setRunning(true);
    setProgress(`Starting ${mode}…`);
    let latest: Evaluation | null = null;
    try {
      const complete = await runEvaluation({
        mode,
        runner: (job) => service.runLocal(job),
        warmupLatencyMs: service.warmLatencyMs,
        onDeviceModel: normalizeModelIdentity(modelIdentity),
        promptVersion: extractVersion,
        signal: current.signal,
        onUpdate: (evaluation) => {
          latest = evaluation;
          const last = evaluation.rows.at(-1);
          const detail = last?.error ? ` — ${formatFailureStatus(last)}` : '';
          setProgress(`${mode}: ${evaluation.rows.length}/${evaluation.total}${detail}`);
        },
      });
      setRuns((previous) => [...previous, complete]);
    } catch {
      if (latest) setRuns((previous) => [...previous, latest!]);
      setProgress('Run stopped unexpectedly. Collected rows are retained if available.');
    } finally {
      controller.current = null;
      setRunning(false);
    }
  }
  async function startChangeEvaluation() {
    if (!measuredRunEnabled) return;
    const current = new AbortController();
    controller.current = current;
    setRunning(true); setProgress('Starting run2…');
    let latest: Run2Evaluation | null = null;
    try {
      const complete = await runChangeEvaluation({ runner: job => service.runLocal(job),
        warmupLatencyMs: service.warmLatencyMs, onDeviceModel: normalizeModelIdentity(modelIdentity),
        signal: current.signal, onUpdate: evaluation => {
          latest = evaluation;
          setProgress(`run2: ${evaluation.rows.length}/${evaluation.total}`);
        } });
      setRuns(previous => [...previous, complete]);
    } catch {
      if (latest) setRuns(previous => [...previous, latest!]);
      setProgress('Run stopped unexpectedly. Collected rows are retained if available.');
    } finally {
      controller.current = null; setRunning(false);
    }
  }
  async function startGate2(practice = false) {
    if (!measuredRunEnabled) return;
    const current = new AbortController();
    controller.current = current;
    setRunning(true); setProgress(practice ? 'Starting unscored practice…' : 'Starting run3…');
    let latest: Run3Evaluation | null = null;
    try {
      const execute = practice ? runPracticeV2 : runGate2;
      const complete = await execute({ runner: job => service.runLocal(job), warmupLatencyMs: service.warmLatencyMs,
        onDeviceModel: normalizeModelIdentity(modelIdentity), signal: current.signal, onUpdate: evaluation => {
          latest = evaluation;
          setProgress(`${practice ? 'practice-v2' : 'run3'}: ${evaluation.rows.length}/${evaluation.total}`);
        } });
      setRuns(previous => [...previous, complete]);
    } catch {
      if (latest) setRuns(previous => [...previous, latest!]);
      setProgress('Run stopped unexpectedly. Collected rows are retained if available.');
    } finally {
      controller.current = null; setRunning(false);
    }
  }
  function download() {
    const file = new Blob(
      [
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            firstEvaluationAfterReload: firstEvaluationAfterReload(),
            runs,
          },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'thoughtpartner-evaluation.json';
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="app">
      <header className="header">
        <div>
          <div className="eyebrow">Development only</div>
          <h1>Evaluation playground</h1>
        </div>
        <a href="/">Back to notebook</a>
      </header>
      <Notices configured={config !== null} state={service.state} />
      <main>
        <section className="panel">
          <label htmlFor="extract-version">Extraction prompt version</label>{' '}
          <select
            id="extract-version"
            value={extractVersion}
            disabled={identityLocked}
            onChange={(event) => setExtractVersion(event.target.value as ExtractVersion)}
          >
            <option value="extract.v2">extract.v2</option>
            <option value="extract.v1">extract.v1</option>
          </select>
          <p>The version is fixed after the first measured run; export and reload to change it.</p>
        </section>
        <section className="panel" style={{ marginTop: 24 }}>
          <h2>Run 0 · practice prompts</h2>
          <p>Practice only; never scored. Output stays on this device.</p>
          <label>
            Prompt{' '}
            <select
              value={prompt}
              onChange={(e) => select(e.target.value as PromptName, example, profile)}
            >
              {Object.keys(prompts).filter(name => TRIAGE_PROMPT_SET !== 'v2.1' || name !== 'whynote')
                .map((name) => (
                <option key={name} value={name}>
                  {promptFor(name as PromptName, extractVersion).version}
                </option>
              ))}
            </select>
          </label>{' '}
          <label>
            Practice note{' '}
            <select value={example} onChange={(e) => select(prompt, e.target.value, profile)}>
              {examples.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id}: {item.title}
                </option>
              ))}
            </select>
          </label>{' '}
          <label>
            Profile{' '}
            <select
              value={profile}
              onChange={(e) => select(prompt, example, e.target.value as ProfileId)}
            >
              <option value="A">A</option>
              <option value="B">B</option>
            </select>
          </label>
          <p>
            Input can be edited. Size: {sizeInCharacters(prompt, input, extractVersion)} characters,
            including fixed context and schema.
          </p>
          <textarea
            aria-label="Prompt input"
            style={{ minHeight: 180 }}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <p>
            <button
              disabled={Boolean(practiceReason)}
              aria-describedby={practiceReason ? 'practice-reason' : undefined}
              onClick={run}
            >
              Run local practice
            </button>
          </p>
          {practiceReason && <p id="practice-reason">{practiceReason}</p>}
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{result}</pre>
        </section>
        <section className="panel" style={{ marginTop: 24 }}>
          <h2>Run 1 · scored extraction</h2>
          <p>20 invented notes, three repeats, two seconds between calls. Keep this tab visible.</p>
          <label htmlFor="model-identity">
            On-device model (as read from chrome://on-device-internals → Broker State)
          </label>
          <input
            id="model-identity"
            type="text"
            maxLength={200}
            required
            value={modelIdentity}
            disabled={identityLocked}
            onChange={(event) => setModelIdentity(event.target.value)}
            placeholder="Component name and version"
          />
          <p>Self-reported, not verified by the API. Export and reload for a different model.</p>
          <button disabled={!measuredRunEnabled} aria-describedby={measuredReason ? 'measured-reason' : undefined}
            onClick={() => void startEvaluation('run1')}>
            Start Run 1
          </button>{' '}
          <button disabled={!measuredRunEnabled} aria-describedby={measuredReason ? 'measured-reason' : undefined}
            onClick={() => void startEvaluation('latency')}>
            Start latency gate and curve
          </button>{' '}
          <button disabled={!measuredRunEnabled} aria-describedby={measuredReason ? 'measured-reason' : undefined}
            onClick={() => void startChangeEvaluation()}>Start Run 2 · change detection</button>{' '}
          <button disabled={!measuredRunEnabled} aria-describedby={measuredReason ? 'measured-reason' : undefined}
            onClick={() => void startGate2(true)}>Start practice · unscored</button>{' '}
          <button disabled={!measuredRunEnabled} aria-describedby={measuredReason ? 'measured-reason' : undefined}
            onClick={() => void startGate2()}>Start Run 3 · Gate 2</button>{' '}
          <button
            disabled={!running || !controller.current}
            aria-describedby={!running || !controller.current ? 'cancel-reason' : undefined}
            onClick={() => controller.current?.abort()}
          >
            Cancel run
          </button>{' '}
          <button disabled={runs.length === 0} aria-describedby={runs.length === 0 ? 'export-reason' : undefined}
            onClick={download}>
            Export JSON
          </button>
          <p>Run 2 uses the frozen target span as both earlier statement and quote;
            code shortcuts need no model call.</p>
          <p>Practice runs only p1–p4 and d1–d3, unscored; D-028 calls for no second practice run.
            Run 3 uses 27 synthetic note passes.
            Exports are local-only and can contain profile-derived text.</p>
          {measuredReason && <p id="measured-reason">{measuredReason}</p>}
          {(!running || !controller.current) && <p id="cancel-reason">No measured run is active to cancel.</p>}
          {runs.length === 0 && <p id="export-reason">Complete or stop a measured run before exporting.</p>}
          <p aria-live="polite">{progress}</p>
          {runs.map((run, index) => (
            <div key={index}>
              <h3>
                {run.mode}: {run.complete ? 'complete' : 'incomplete'}
              </h3>
              <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {JSON.stringify({ reason: run.reason, summary: run.summary }, null, 2)}
              </pre>
            </div>
          ))}
        </section>
      </main>
      <StatusBar service={service} configured={config !== null} foreground={foreground} />
    </div>
  );
}
