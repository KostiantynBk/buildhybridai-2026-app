import { SDK_VERSION } from 'firebase/app';
import notesFile from '../../eval/set-v1/notes.json';
import { LocalError } from '../ai/localModel';
import { hiddenNow, safeErrorName } from '../ai/errorMetadata';
import {
  extract,
  extractInput,
  extractVersion,
  type Item,
  type LocalRunner,
} from '../pipeline/extract';
import { sizeInCharacters } from './playground';
import { summarize } from './scoring';
import { normalizeModelIdentity } from './modelIdentity';

export type RunMode = 'run1' | 'latency';
export type EvaluationRow = {
  noteId: string;
  repetition: number;
  promptVersion: string;
  inputSize: number;
  inputSizeUnit: 'characters';
  latencyMs: number | null;
  source: string | null;
  schemaValid: boolean;
  returnedItems: Item[];
  items: Item[];
  beforeDrop: number;
  quoteExact: number;
  droppedBadQuotes: number;
  droppedDuplicates: number;
  error: string | null;
  errorName: string | null;
  errorClass: string | null;
  availabilityAfter: string | null;
  elapsedMs: number | null;
  hidden: boolean | null;
  wordCount: number;
  sampleKind: 'run1' | 'first-evaluation' | 'gate' | 'curve';
  firstEvaluationAttemptAfterReload: boolean;
};
export type Evaluation = {
  environment: {
    timestamp: string;
    chromeVersion: string;
    sdkVersion: string;
    onDeviceModel: string;
    promptVersion: string;
    setVersion: string;
    warmupLatencyMs: number | null;
  };
  mode: RunMode;
  total: number;
  complete: boolean;
  reason: string | null;
  rows: EvaluationRow[];
  summary: unknown;
};
type FirstEvaluation = { latencyMs: number | null; source: string | null; error: string | null };
let startedSinceReload = false;
let firstEvaluation: FirstEvaluation | null = null;
export function firstEvaluationAfterReload(): FirstEvaluation | null {
  return firstEvaluation;
}
export function recordFirstEvaluation(first: boolean, value: FirstEvaluation): void {
  if (!first) return;
  if (
    value.source === null &&
    ['cancelled', 'not-configured', 'not-ready', 'unsupported'].includes(value.error ?? '')
  ) {
    startedSinceReload = false;
    firstEvaluation = null;
    return;
  }
  firstEvaluation = value;
}
export function markEvaluationCall(): boolean {
  const first = !startedSinceReload;
  startedSinceReload = true;
  return first;
}
export function quantile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
export function paragraphOfLength(text: string, count: number): string {
  const words = text.trim().split(/\s+/);
  return Array.from({ length: count }, (_, i) => words[i % words.length]).join(' ');
}
export function run1LatencyByNote(rows: EvaluationRow[]) {
  const ids = [...new Set(rows.map((row) => row.noteId))];
  return ids.map((noteId) => {
    const noteRows = rows.filter(
      (row) => row.noteId === noteId && !row.firstEvaluationAttemptAfterReload,
    );
    const values = noteRows
      .filter((row) => row.source === 'on_device' && row.latencyMs !== null)
      .map((row) => row.latencyMs!);
    return {
      noteId,
      wordCount: rows.find((row) => row.noteId === noteId)!.wordCount,
      sampleCount: values.length,
      medianMs: median(values),
      maxMs: values.length ? Math.max(...values) : null,
    };
  });
}
export function latencySummary(rows: EvaluationRow[]) {
  const gateRows = rows.filter(
    (row) => row.sampleKind === 'gate' && !row.firstEvaluationAttemptAfterReload,
  );
  const validLengths = gateRows.every((row) => row.wordCount >= 150 && row.wordCount <= 250);
  const gateValues = gateRows.map((row) => {
    if (row.error || !row.schemaValid || row.source !== 'on_device' || row.latencyMs === null) {
      return Math.max(12001, row.latencyMs ?? 0);
    }
    return row.latencyMs;
  });
  const gate = {
    wordCounts: [...new Set(gateRows.map((row) => row.wordCount))],
    wordCountInBand: validLengths && gateRows.length > 0,
    sampleCount: gateRows.length,
    failedCalls: gateRows.filter((row) => row.error || !row.schemaValid).length,
    penaltyFloorMs: 12001,
    medianMs: gateRows.length === 20 && validLengths ? median(gateValues) : null,
    p95Ms: gateRows.length === 20 && validLengths ? quantile(gateValues, 0.95) : null,
  };
  const sizes = [100, 250, 500, 1000, 2000].map((wordCount) => {
    const values = rows
      .filter(
        (row) =>
          row.sampleKind === 'curve' &&
          !row.firstEvaluationAttemptAfterReload &&
          row.wordCount === wordCount &&
          row.source === 'on_device' &&
          row.latencyMs !== null,
      )
      .map((row) => row.latencyMs!);
    return {
      wordCount,
      sampleCount: values.length,
      medianMs: median(values),
      maxOfFiveMs: values.length === 5 ? Math.max(...values) : null,
    };
  });
  return {
    firstEvaluationAfterReload: firstEvaluationAfterReload(),
    gate,
    sizes,
    percentileMethod: 'gate p95 uses nearest-rank; curve reports observed maximum, not p95',
  };
}
export async function runEvaluation(options: {
  mode: RunMode;
  runner: LocalRunner;
  warmupLatencyMs: number | null;
  onDeviceModel: string;
  signal: AbortSignal;
  onUpdate?: (evaluation: Evaluation) => void;
  rest?: () => Promise<void>;
  chromeVersion?: string;
}): Promise<Evaluation> {
  const { mode, runner, signal } = options;
  const onDeviceModel = normalizeModelIdentity(options.onDeviceModel);
  if (!onDeviceModel) throw new Error('On-device model identity is required.');
  const notes = notesFile.notes;
  const gateText = paragraphOfLength(notes[0].text, 200);
  const gateWords = gateText.trim().split(/\s+/).length;
  if (gateWords < 150 || gateWords > 250)
    throw new Error('Gate paragraph is outside the 150–250 word range.');
  const gateNote = { ...notes[0], text: gateText };
  const schedule: Array<{
    note: (typeof notes)[number];
    repetition: number;
    sampleKind: EvaluationRow['sampleKind'];
  }> =
    mode === 'run1'
      ? notes.flatMap((note) =>
          [1, 2, 3].map((repetition) => ({ note, repetition, sampleKind: 'run1' })),
        )
      : [
          ...(!startedSinceReload
            ? [{ note: gateNote, repetition: 1, sampleKind: 'first-evaluation' as const }]
            : []),
          ...Array.from({ length: 20 }, (_, index) => ({
            note: gateNote,
            repetition: index + 1,
            sampleKind: 'gate' as const,
          })),
          ...[100, 250, 500, 1000, 2000].flatMap((wordCount) =>
            [1, 2, 3, 4, 5].map((repetition) => ({
              note: { ...notes[0], text: paragraphOfLength(notes[0].text, wordCount) },
              repetition,
              sampleKind: 'curve' as const,
            })),
          ),
        ];
  const evaluation: Evaluation = {
    environment: {
      timestamp: new Date().toISOString(),
      chromeVersion:
        options.chromeVersion ??
        (typeof navigator === 'undefined'
          ? 'not detected'
          : (navigator.userAgent.match(/Chrome\/[^ ]+/)?.[0] ?? 'not detected')),
      sdkVersion: SDK_VERSION,
      onDeviceModel,
      promptVersion: extractVersion,
      setVersion: notesFile.version,
      warmupLatencyMs: options.warmupLatencyMs,
    },
    mode,
    total: schedule.length,
    complete: false,
    reason: null,
    rows: [],
    summary: null,
  };
  const update = () => {
    evaluation.summary =
      mode === 'run1'
        ? {
            ...summarize(evaluation.rows, notes),
            firstEvaluationAfterReload: firstEvaluationAfterReload(),
            latencyByNote: run1LatencyByNote(evaluation.rows),
          }
        : latencySummary(evaluation.rows);
    options.onUpdate?.({ ...evaluation, rows: [...evaluation.rows] });
  };
  for (let index = 0; index < schedule.length; index++) {
    if (signal.aborted) {
      evaluation.reason = 'Cancelled by user.';
      break;
    }
    const entry = schedule[index];
    const first = markEvaluationCall();
    const row: EvaluationRow = {
      noteId: entry.note.id,
      repetition: entry.repetition,
      promptVersion: extractVersion,
      inputSize: sizeInCharacters('extract', extractInput(entry.note.title, entry.note.text)),
      inputSizeUnit: 'characters',
      latencyMs: null,
      source: null,
      schemaValid: false,
      returnedItems: [],
      items: [],
      beforeDrop: 0,
      quoteExact: 0,
      droppedBadQuotes: 0,
      droppedDuplicates: 0,
      error: null,
      errorName: null,
      errorClass: null,
      availabilityAfter: null,
      elapsedMs: null,
      hidden: null,
      wordCount: entry.note.text.trim().split(/\s+/).length,
      sampleKind: entry.sampleKind,
      firstEvaluationAttemptAfterReload: first,
    };
    try {
      const result = await extract(runner, entry.note.title, entry.note.text, signal);
      Object.assign(row, {
        latencyMs: result.latencyMs,
        source: result.source,
        schemaValid: true,
        returnedItems: result.data.items,
        items: result.items,
        beforeDrop: result.beforeDrop,
        quoteExact: result.quoteExact,
        droppedBadQuotes: result.droppedBadQuotes,
        droppedDuplicates: result.droppedDuplicates,
      });
    } catch (error) {
      row.error = error instanceof LocalError ? error.code : 'local-call-failed';
      row.errorClass = row.error;
      row.errorName =
        error instanceof LocalError
          ? (error.diagnostics?.errorName ?? safeErrorName(error))
          : safeErrorName(error);
      row.hidden =
        error instanceof LocalError ? (error.diagnostics?.hidden ?? hiddenNow()) : hiddenNow();
      if (error instanceof LocalError && error.diagnostics) {
        row.source = error.diagnostics.source ?? null;
        row.latencyMs = error.diagnostics.latencyMs ?? null;
        row.availabilityAfter = error.diagnostics.availabilityAfter ?? null;
        row.elapsedMs = error.diagnostics.elapsedMs ?? null;
      }
      if (row.error === 'cancelled') evaluation.reason = 'Cancelled by user.';
      else if (row.error !== 'invalid-output') evaluation.reason = `Stopped: ${row.error}.`;
    }
    recordFirstEvaluation(first, {
      latencyMs: row.latencyMs,
      source: row.source,
      error: row.error,
    });
    evaluation.rows.push(row);
    update();
    if (evaluation.reason || signal.aborted) {
      if (signal.aborted && !evaluation.reason) evaluation.reason = 'Cancelled by user.';
      break;
    }
    if (index < schedule.length - 1) {
      if (options.rest) await options.rest();
      else await new Promise<void>((resolve) => setTimeout(resolve, 2000));
    }
  }
  if (!evaluation.reason && evaluation.rows.length === schedule.length) evaluation.complete = true;
  update();
  return evaluation;
}
