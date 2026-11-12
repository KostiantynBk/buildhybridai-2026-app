// Restrict diagnostics to known names/codes: exception fields can contain arbitrary user content.
const names = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'URIError',
  'EvalError',
  'UnknownError',
  'NotSupportedError',
  'QuotaExceededError',
  'AbortError',
  'InvalidStateError',
  'NotReadableError',
  'TimeoutError',
  'NotAllowedError',
  'OperationError',
  'SecurityError',
  'DataError',
  'NetworkError',
  'InvalidAccessError',
  'NotFoundError',
  'EncodingError',
  'DataCloneError',
  'ConstraintError',
  'LocalError',
  'AggregateError',
  'IndexSizeError',
  'HierarchyRequestError',
  'WrongDocumentError',
  'InvalidCharacterError',
  'NoModificationAllowedError',
  'InUseAttributeError',
  'InvalidModificationError',
  'NamespaceError',
  'TypeMismatchError',
  'URLMismatchError',
  'InvalidNodeTypeError',
  'TransactionInactiveError',
  'ReadOnlyError',
  'VersionError',
]);
// Firebase AI 3.1.0 AIErrorCode values from node_modules/@firebase/ai/dist/ai-public.d.ts.
const aiCodes = new Set([
  'error',
  'request-error',
  'response-error',
  'fetch-error',
  'session-closed',
  'invalid-content',
  'api-not-enabled',
  'already-initialized',
  'invalid-schema',
  'no-api-key',
  'no-app-id',
  'no-model',
  'no-project-id',
  'parse-failed',
  'unsupported',
]);
export function safeErrorName(value: unknown): string {
  try {
    const root = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const causeValue = root.cause;
    const cause =
      causeValue && typeof causeValue === 'object' ? (causeValue as Record<string, unknown>) : null;
    const snapshot = (candidate: Record<string, unknown>) => {
      const name = candidate.name;
      const code = candidate.code;
      return { name, code };
    };
    const rootSnapshot = snapshot(root);
    const causeSnapshot = cause === root ? rootSnapshot : cause ? snapshot(cause) : null;
    const candidates = causeSnapshot ? [causeSnapshot, rootSnapshot] : [rootSnapshot];
    const allowed = (list: Set<string>, captured: unknown) => {
      if (typeof captured !== 'string') return undefined;
      for (const entry of list) if (entry === captured) return entry;
      return undefined;
    };
    for (const candidate of candidates) {
      const code =
        candidate.name === 'FirebaseError' ? allowed(aiCodes, candidate.code) : undefined;
      if (code && code !== 'error') return code;
    }
    for (const candidate of candidates) {
      const name = allowed(names, candidate.name);
      if (name && name !== 'Error' && name !== 'LocalError') return name;
    }
    if (rootSnapshot.name === 'FirebaseError' && allowed(aiCodes, rootSnapshot.code) === 'error') {
      return 'error';
    }
    const rootName = allowed(names, rootSnapshot.name);
    if (rootName) return rootName;
  } catch {
    // Invalid or throwing properties are not trusted.
  }
  return 'OtherError';
}
export function safeAvailability(value: string): string {
  return [
    'available',
    'downloadable',
    'downloading',
    'unavailable',
    'unsupported',
    'check failed',
  ].includes(value)
    ? value
    : 'unknown';
}
export function hiddenNow(): boolean | null {
  return typeof document === 'undefined' ? null : document.visibilityState === 'hidden';
}
