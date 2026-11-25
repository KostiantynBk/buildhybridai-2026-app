import Ajv from 'ajv';
import type { LocalStore, Snapshot } from '../store';
import type { LocalService } from '../store/scheduler';
import type { ExtractVersion } from '../pipeline/extract';
import { pickV1 } from '../pipeline/prompts/pick.v1';
import { angleLabels, eligibleMarks } from './marks';

type Marks = ReturnType<typeof eligibleMarks>;
type PickResult = { ids: string[]; chosen: boolean };
const validate = new Ajv().compile(pickV1.schema);
export function markFingerprint(marks: Marks): string {
  return JSON.stringify(marks.map(({ mark }) => [mark.id, mark.itemVersion, mark.paragraphVersion]));
}
export function pickFingerprint(snapshot: Snapshot, marks: Marks): string {
  // A pure paragraph reorder changes plan-order input, so it intentionally triggers another pick.
  const paragraphs = [...snapshot.paragraphs].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map(p => [p.id, p.version, p.order]);
  return JSON.stringify([paragraphs, markFingerprint(marks)]);
}
function workFingerprint(snapshot: Snapshot): string {
  return JSON.stringify(snapshot.jobs.map(job => [job.key, job.status, job.attempts, job.nextRunAt])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}
function foreground(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}
export function pickInput(marks: Marks): string {
  return marks.slice(0, 24).map(({ item, mark }, index) =>
    `${index + 1}. [${angleLabels[mark.angle!]}] ${item.kind}: ${item.text} — "${mark.itemQuote}"`).join('\n');
}

/** Per-mounted-App ranking cache. It never writes a pick job or result to the store. */
export class PickShortlist {
  private results = new Map<string, PickResult>();
  private attempted = new Set<string>();
  private pending = '';
  constructor(private readonly changed: () => void) {}
  view(snapshot: Snapshot, cloudMode: boolean) {
    const marks = eligibleMarks(snapshot);
    const fingerprint = pickFingerprint(snapshot, marks);
    const result = cloudMode ? undefined : this.results.get(fingerprint);
    const byId = new Map(marks.map(value => [value.mark.id, value]));
    const selected = result?.ids.flatMap(id => byId.get(id) ? [byId.get(id)!] : []) ?? [];
    return { marks: result ? selected : marks.slice(0, 3), chosen: !!result?.chosen,
      choosing: !cloudMode && this.pending === fingerprint };
  }
  async run(store: LocalStore, service: LocalService, signal: AbortSignal,
    version: () => ExtractVersion = () => 'extract.v2', now: () => number = Date.now): Promise<void> {
    if (signal.aborted || !foreground()) return;
    const initial = await store.pickSnapshot(version(), now());
    const before = initial.snapshot;
    if (signal.aborted || !foreground() || !initial.ready) return;
    const marks = eligibleMarks(before);
    if (marks.length < 4) return;
    const fingerprint = pickFingerprint(before, marks);
    const priorWork = workFingerprint(before);
    if (this.attempted.has(fingerprint)) return;
    const candidates = marks.slice(0, 24);
    const clearPending = () => {
      if (this.pending === fingerprint) { this.pending = ''; this.changed(); }
    };
    const stillValid = async () => {
      if (signal.aborted || !foreground()) return false;
      const current = await store.pickSnapshot(version(), now());
      return !signal.aborted && foreground() && current.ready &&
        workFingerprint(current.snapshot) === priorWork &&
        pickFingerprint(current.snapshot, eligibleMarks(current.snapshot)) === fingerprint;
    };
    signal.addEventListener('abort', clearPending, { once: true });
    let dispatched = false;
    try {
      const response = await service.runLocal<{ picks: number[] }>({ prompt: pickInput(marks),
        schema: pickV1.schema, instructions: pickV1, requiredMode: 'on_device', signal, beforeDispatch: stillValid,
        onDispatch: () => {
          dispatched = true; this.attempted.add(fingerprint); this.pending = fingerprint; this.changed();
        } });
      clearPending();
      if (!dispatched || signal.aborted || response.source !== 'on_device' || !validate(response.data)) return;
      if (!await stillValid()) return;
      const indices = [...new Set(response.data.picks.filter(value => value >= 1 && value <= candidates.length))];
      if (!indices.length) return;
      const chosen = indices.map(index => candidates[index - 1].mark.id);
      const ids = [...chosen, ...marks.map(value => value.mark.id).filter(id => !chosen.includes(id))].slice(0, 3);
      this.results.set(fingerprint, { ids, chosen: true });
    } catch { /* Optional ranking silently falls back to plan order. */ }
    finally {
      signal.removeEventListener('abort', clearPending);
      clearPending();
      this.changed();
    }
  }
}
