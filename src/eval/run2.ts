import { SDK_VERSION } from 'firebase/app';
import changes from '../../eval/set-v1/changes.json';
import { LocalError } from '../ai/localModel';
import { safeErrorName } from '../ai/errorMetadata';
import { compare, containsQuote, type ComparisonStatus } from '../pipeline/compare';
import type { LocalRunner } from '../pipeline/extract';
import { builtInSettings, type SettingsSnapshot } from '../settings/defaults';
import { normalizeModelIdentity } from './modelIdentity';
import { markEvaluationCall, recordFirstEvaluation } from './runner';

export interface Run2Row {
  noteId: string; repetition: number; expectedChanged: boolean; status: ComparisonStatus | null;
  newQuoteFound: boolean | null; latencyMs: number | null; source: string | null; promptVersion: 'compare.v1';
  error: string | null; errorName: string | null;
}
export interface Run2Evaluation {
  mode: 'run2'; total: number; complete: boolean; reason: string | null; rows: Run2Row[]; summary: unknown;
  environment: { timestamp: string; chromeVersion: string; sdkVersion: string; onDeviceModel: string;
    promptVersion: 'compare.v1'; setVersion: string; warmupLatencyMs: number | null; settings: SettingsSnapshot };
}
export async function runChangeEvaluation(options: {
  runner: LocalRunner; signal: AbortSignal; onDeviceModel: string; warmupLatencyMs: number | null;
  onUpdate?: (run: Run2Evaluation) => void; rest?: () => Promise<void>; chromeVersion?: string;
}): Promise<Run2Evaluation> {
  const model = normalizeModelIdentity(options.onDeviceModel);
  if (!model) throw new Error('On-device model identity is required.');
  const schedule = changes.changes.flatMap(change => [1, 2, 3].map(repetition => ({ change, repetition })));
  const run: Run2Evaluation = { mode: 'run2', total: schedule.length, complete: false, reason: null, rows: [],
    summary: null, environment: { timestamp: new Date().toISOString(),
      chromeVersion: options.chromeVersion ?? (typeof navigator === 'undefined' ? 'not detected' :
        navigator.userAgent.match(/Chrome\/[^ ]+/)?.[0] ?? 'not detected'),
      sdkVersion: SDK_VERSION, onDeviceModel: model, promptVersion: 'compare.v1', setVersion: changes.version,
      warmupLatencyMs: options.warmupLatencyMs, settings: builtInSettings() } };
  const update = () => {
    const changed = run.rows.filter(row => row.status === 'changed');
    run.summary = { actualChangeRuns: run.rows.filter(row => row.expectedChanged).length,
      actualChangesFlagged: run.rows.filter(row => row.expectedChanged &&
        (row.status === 'changed' || row.status === 'removed')).length,
      unchangedRuns: run.rows.filter(row => !row.expectedChanged).length,
      falseFlags: run.rows.filter(row => !row.expectedChanged &&
        (row.status === 'changed' || row.status === 'removed')).length,
      changedRows: changed.length, changedQuotesFound: changed.filter(row => row.newQuoteFound).length,
      changedQuoteFoundRate: changed.length ? changed.filter(row => row.newQuoteFound).length / changed.length : null,
      errors: run.rows.filter(row => row.error).length };
    options.onUpdate?.({ ...run, rows: [...run.rows] });
  };
  for (let i = 0; i < schedule.length; i++) {
    if (options.signal.aborted) { run.reason = 'Cancelled by user.'; break; }
    const { change, repetition } = schedule[i];
    const row: Run2Row = { noteId: change.noteId, repetition, expectedChanged: change.expectedChanged,
      status: null, newQuoteFound: null, latencyMs: null, source: null, promptVersion: 'compare.v1',
      error: null, errorName: null };
    const needsModel = !containsQuote(change.editedText, change.targetSpan);
    const first = needsModel ? markEvaluationCall() : false;
    try {
      // The frozen target span is used as both the earlier statement and earlier quote.
      const result = await compare(options.runner, { text: change.targetSpan, quote: change.targetSpan },
        change.editedText, options.signal);
      Object.assign(row, { status: result.status, newQuoteFound: result.newQuoteFound,
        latencyMs: result.latencyMs, source: result.source });
    } catch (error) {
      row.error = error instanceof LocalError ? error.code : 'local-call-failed';
      row.errorName = error instanceof LocalError && error.diagnostics?.errorName
        ? safeErrorName({ name: error.diagnostics.errorName }) : safeErrorName(error);
      if (error instanceof LocalError && error.diagnostics) {
        row.source = error.diagnostics.source ?? null;
        row.latencyMs = error.diagnostics.latencyMs ?? null;
      }
      if (row.error !== 'invalid-output') run.reason = row.error === 'cancelled'
        ? 'Cancelled by user.' : `Stopped: ${row.error}.`;
    }
    if (needsModel) recordFirstEvaluation(first, { latencyMs: row.latencyMs, source: row.source, error: row.error });
    run.rows.push(row);
    update();
    if (run.reason || options.signal.aborted) {
      if (!run.reason) run.reason = 'Cancelled by user.';
      break;
    }
    if (i < schedule.length - 1) {
      if (options.rest) await options.rest();
      else await new Promise<void>(resolve => setTimeout(resolve, 2000));
    }
  }
  run.complete = !run.reason && run.rows.length === schedule.length;
  update();
  return run;
}
