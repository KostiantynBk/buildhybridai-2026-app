export function normalizeModelIdentity(value: string): string {
  return value.trim().slice(0, 200).trim();
}

export function canStartMeasuredRun(options: {
  configured: boolean;
  ready: boolean;
  running: boolean;
  foreground: boolean;
  model: string;
}): boolean {
  return (
    options.configured &&
    options.ready &&
    !options.running &&
    options.foreground &&
    normalizeModelIdentity(options.model).length > 0
  );
}
