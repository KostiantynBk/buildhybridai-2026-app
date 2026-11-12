export type FailureStatus = {
  errorName: string | null;
  errorClass: string | null;
  availabilityAfter: string | null;
  elapsedMs: number | null;
  hidden: boolean | null;
};
export function formatFailureStatus(details: FailureStatus): string {
  const hidden = details.hidden === null ? 'unknown' : details.hidden ? 'yes' : 'no';
  const elapsed = details.elapsedMs === null ? 'unknown' : `${Math.round(details.elapsedMs)} ms`;
  return (
    `class: ${details.errorClass ?? 'unknown'} · name: ${details.errorName ?? 'unknown'}` +
    ` · availability: ${details.availabilityAfter ?? 'not rechecked'} · elapsed: ${elapsed} · hidden: ${hidden}`
  );
}
