import { SDK_VERSION } from 'firebase/app';
import notes from '../../eval/set-v1/notes.json';
import { LocalError } from '../ai/localModel';
import { safeErrorName } from '../ai/errorMetadata';
import { extract, type LocalRunner } from '../pipeline/extract';
import { filterQuestion } from '../pipeline/leakFilter';
import { selectConcerns, type Pick } from '../pipeline/selectConcerns';
import { runAngles, runQuestion, runWhyNote, type TriageItem } from '../pipeline/triage';
import { demoNeverSend, demoProfile } from '../profile/profile';
import { builtInSettings } from '../settings/defaults';
import { normalizeModelIdentity } from './modelIdentity';

const subset = new Set(['n01', 'n03', 'n07', 'n11', 'n14']);
const profiles = ['A', 'B'] as const;
type ProfileId = typeof profiles[number];
type QuestionRow = { key: string; question: string | null; keptOut: string[]; passed: boolean;
  privateBefore: boolean; privateAfter: boolean; latencyMs: number; source: string };
type WhyRow = { profile: ProfileId; key: string; seeing: string; why: string; used: string[]; source: string };
type Run3Row = { noteId: string; repetition: number; concerns: Array<{ item: number; angle: string;
  concern: string; checkable: boolean }>; picks: Record<ProfileId, Array<{ key: string; angle: string; score: number;
    brief: boolean }>>; questions: QuestionRow[]; whynotes: WhyRow[]; sources: string[]; firstTagMs: number | null;
  blindSpotMatched: boolean; error: string | null; errorName: string | null };
export interface Run3Evaluation {
  mode: 'run3'; total: number; complete: boolean; reason: string | null; rows: Run3Row[]; summary: unknown;
  environment: { timestamp: string; chromeVersion: string; sdkVersion: string; onDeviceModel: string;
    promptVersions: string[]; setVersion: string; warmupLatencyMs: number | null;
    settings: ReturnType<typeof builtInSettings>;
    sharing: 'local-only'; rulings: { notePasses: number; baselineOnlyMetrics: true; questionSharing: string;
      latencySelection: string; briefQuestion: true; briefWhyNote: false; ratingSeed: number } };
}
const ratingSeed = 0x53696465;
function sample<T>(values: T[], count: number, seed: number): T[] {
  const copy = [...values];
  let state = seed >>> 0;
  for (let i = copy.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const index = state % (i + 1);
    [copy[i], copy[index]] = [copy[index], copy[i]];
  }
  return copy.slice(0, count);
}
function rateSummary(rows: Run3Row[]) {
  const baseline = rows.filter(row => row.repetition === 1 && !row.error);
  const questions = baseline.flatMap(row => row.questions);
  const whynotes = baseline.flatMap(row => row.whynotes);
  const concerns = baseline.flatMap(row => row.concerns.map((concern, index) =>
    ({ noteId: row.noteId, index, concern })));
  const latencies = baseline.map(row => row.firstTagMs).filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  const median = latencies.length ? latencies.length % 2 ? latencies[(latencies.length - 1) / 2]
    : (latencies[latencies.length / 2 - 1] + latencies[latencies.length / 2]) / 2 : null;
  const blindSpotMatches = baseline.filter(row => row.blindSpotMatched).length;
  const privateBefore = questions.filter(q => q.privateBefore).length;
  const privateAfter = questions.filter(q => q.privateAfter).length;
  const topPickDiffers = baseline.filter(row => row.picks.A[0] && row.picks.B[0] &&
    row.picks.A[0].key !== row.picks.B[0].key).length;
  return { baselineNotes: baseline.length, blindSpotMatches,
    blindSpotRate: baseline.length ? blindSpotMatches / baseline.length : null,
    questions: questions.length, privateBefore,
    privateBeforeRate: questions.length ? privateBefore / questions.length : null,
    privateAfter, privateAfterRate: questions.length ? privateAfter / questions.length : null,
    topPickDiffers, topPickDiffersRate: baseline.length ? topPickDiffers / baseline.length : null,
    firstTagMedianMs: median, firstTagCount: latencies.length,
    sources: baseline.flatMap(row => row.sources),
    ratingSample: { instructions: { concerns: 'Would I want this checked?',
      questions: 'Could I answer this without seeing the plan?',
      why: 'Does it say anything about me that is not in the profile?' },
    concerns: sample(concerns, 15, ratingSeed).map(value => ({ ...value, rating: null })),
    questions: sample(questions.filter(q => q.passed), 10, ratingSeed + 1).map(value => ({ ...value, rating: null })),
    whyA: sample(whynotes.filter(why => why.profile === 'A'), 6, ratingSeed + 2)
      .map(value => ({ ...value, rating: null, reviewerRating: null })),
    whyB: sample(whynotes.filter(why => why.profile === 'B'), 6, ratingSeed + 3)
      .map(value => ({ ...value, rating: null, reviewerRating: null })) },
    variance: rows.filter(row => row.repetition > 1 && !row.error).map(row => {
      const first = baseline.find(value => value.noteId === row.noteId);
      return { noteId: row.noteId, repetition: row.repetition,
        concernsSame: first ? JSON.stringify(row.concerns) === JSON.stringify(first.concerns) : null,
        picksSame: first ? JSON.stringify(row.picks) === JSON.stringify(first.picks) : null,
        questionsSame: first ? JSON.stringify(row.questions.map(q => q.question)) ===
          JSON.stringify(first.questions.map(q => q.question)) : null };
    }) };
}
export async function runGate2(options: { runner: LocalRunner; signal: AbortSignal; onDeviceModel: string;
  warmupLatencyMs: number | null; onUpdate?: (run: Run3Evaluation) => void; now?: () => number;
  rest?: () => Promise<void>; chromeVersion?: string }): Promise<Run3Evaluation> {
  const model = normalizeModelIdentity(options.onDeviceModel);
  if (!model) throw new Error('On-device model identity is required.');
  const selectedNotes = notes.notes.filter(note => note.expected.length > 0);
  const schedule = selectedNotes.flatMap(note => (subset.has(note.id) ? [1, 2, 3] : [1])
    .map(repetition => ({ note, repetition })));
  const now = options.now ?? (() => performance.now());
  const run: Run3Evaluation = { mode: 'run3', total: schedule.length, complete: false, reason: null, rows: [],
    summary: null, environment: { timestamp: new Date().toISOString(), chromeVersion: options.chromeVersion ??
      (typeof navigator === 'undefined' ? 'not detected' :
        navigator.userAgent.match(/Chrome\/[^ ]+/)?.[0] ?? 'not detected'),
    sdkVersion: SDK_VERSION, onDeviceModel: model, promptVersions: ['extract.v2', 'angles.v1', 'question.v1',
      'whynote.v1'], setVersion: notes.version, warmupLatencyMs: options.warmupLatencyMs, settings: builtInSettings(),
    sharing: 'local-only', rulings: { notePasses: 27, baselineOnlyMetrics: true,
      questionSharing: 'once per distinct item-version and model concern across selected profiles',
      latencySelection: 'profile A first pick, otherwise B; no pick is N/A',
      briefQuestion: true, briefWhyNote: false, ratingSeed } } };
  const update = () => { run.summary = rateSummary(run.rows); options.onUpdate?.({ ...run, rows: [...run.rows] }); };
  for (let index = 0; index < schedule.length; index++) {
    if (options.signal.aborted) { run.reason = 'Cancelled by user.'; break; }
    const { note, repetition } = schedule[index];
    const row: Run3Row = { noteId: note.id, repetition, concerns: [], picks: { A: [], B: [] }, questions: [],
      whynotes: [], sources: [], firstTagMs: null, blindSpotMatched: false, error: null, errorName: null };
    const started = now();
    try {
      const extraction = await extract(options.runner, note.title, note.text, options.signal, 'extract.v2');
      if (extraction.source !== 'on_device') throw new LocalError('privacy-fault', 'Local source not verified.',
        { source: extraction.source === 'in_cloud' ? 'in_cloud' : 'not reported' });
      row.sources.push(extraction.source);
      const items: TriageItem[] = extraction.items.map((item, position) => ({ ...item,
        lineageId: `${note.id}-${position}`, version: 1 }));
      const angles = await runAngles(options.runner, note.text, items, options.signal);
      if (angles.source !== 'code') row.sources.push(angles.source);
      row.concerns = angles.concerns;
      const selections = Object.fromEntries(profiles.map(profile => [profile,
        selectConcerns({ paragraph: note.text, items: angles.items, concerns: angles.concerns,
          profile: demoProfile(profile), used: [], angleCounts: {} }).picked])) as Record<ProfileId, Pick[]>;
      const pool = new Map<string, { pick: Pick; profiles: ProfileId[] }>();
      for (const profile of profiles) for (const pick of selections[profile]) {
        const key = `${pick.item.lineageId}@${pick.item.version}#${pick.modelOrder}`;
        row.picks[profile].push({ key: `${pick.item.lineageId}@${pick.item.version}#${pick.angle}`,
          angle: pick.angle, score: pick.score, brief: pick.brief });
        const existing = pool.get(key);
        if (existing) existing.profiles.push(profile); else pool.set(key, { pick, profiles: [profile] });
      }
      const target = selections.A[0] ?? selections.B[0];
      const targetKey = target ? `${target.item.lineageId}@${target.item.version}#${target.modelOrder}` : null;
      for (const [key, value] of pool) {
        const sourceItem = angles.items.find(item => item.lineageId === value.pick.item.lineageId)!;
        const tokens = [...note.privateTokens, ...value.profiles.flatMap(profile => demoNeverSend(profile))];
        const question = await runQuestion(options.runner, sourceItem, value.pick.concern.angle,
          value.pick.concern.concern,
          value.profiles.flatMap(profile => demoNeverSend(profile)), note.privateTokens, options.signal);
        row.sources.push(question.source);
        const privateBefore = filterQuestion(question.question, [], tokens).reasons.includes('private-token');
        const exposed = question.leak.passed ? question.question : null;
        row.questions.push({ key, question: exposed, keptOut: question.keptOut, passed: question.leak.passed,
          privateBefore,
          privateAfter: exposed ? filterQuestion(exposed, [], tokens).reasons.includes('private-token') : false,
          latencyMs: question.latencyMs, source: question.source });
        if (key === targetKey) row.firstTagMs = Math.max(0, now() - started);
      }
      for (const profile of profiles) for (const pick of selections[profile]) {
        if (pick.brief) continue;
        const key = `${pick.item.lineageId}@${pick.item.version}#${pick.modelOrder}`;
        const question = row.questions.find(value => value.key === key);
        if (!question?.question) continue;
        const why = await runWhyNote(options.runner, pick.item.quote, pick.angle, pick.concern.concern,
          question.question, pick.item.topics, demoProfile(profile), options.signal, pick.lessonId);
        row.sources.push(why.source);
        if (why.note) row.whynotes.push({ profile, key, ...why.note, source: why.source });
      }
      row.blindSpotMatched = note.blindSpots.some(blind => row.concerns.some(concern =>
        concern.angle === blind.angle || blind.questionKeywords.some(keyword =>
          concern.concern.toLocaleLowerCase('en').includes(keyword.toLocaleLowerCase('en')) ||
          row.questions.some(question => question.question?.toLocaleLowerCase('en')
            .includes(keyword.toLocaleLowerCase('en'))))));
    } catch (error) {
      row.error = error instanceof LocalError ? error.code : 'local-call-failed';
      row.errorName = error instanceof LocalError && error.diagnostics?.errorName
        ? safeErrorName({ name: error.diagnostics.errorName }) : safeErrorName(error);
      const source = error instanceof LocalError ? error.diagnostics?.source : undefined;
      if (source) row.sources.push(source === 'on_device' || source === 'in_cloud' ? source : 'unknown');
      run.reason = row.error === 'cancelled' ? 'Cancelled by user.' : `Stopped: ${row.error}.`;
    }
    run.rows.push(row); update();
    if (run.reason || options.signal.aborted) { if (!run.reason) run.reason = 'Cancelled by user.'; break; }
    if (index < schedule.length - 1) {
      if (options.rest) await options.rest(); else await new Promise<void>(resolve => setTimeout(resolve, 2000));
    }
  }
  run.complete = !run.reason && run.rows.length === schedule.length;
  update();
  return run;
}
