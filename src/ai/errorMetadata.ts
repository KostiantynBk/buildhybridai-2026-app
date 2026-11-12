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
    const cause =
      root.cause && typeof root.cause === 'object' ? (root.cause as Record<string, unknown>) : {};
    for (const candidate of [cause, root]) {
      if (
        candidate.name === 'FirebaseError' &&
        typeof candidate.code === 'string' &&
        aiCodes.has(candidate.code) &&
        candidate.code !== 'error'
      )
        return candidate.code;
    }
    for (const candidate of [cause, root]) {
      if (
        typeof candidate.name === 'string' &&
        names.has(candidate.name) &&
        candidate.name !== 'Error' &&
        candidate.name !== 'LocalError'
      )
        return candidate.name;
    }
    if (root.name === 'FirebaseError' && root.code === 'error') return 'error';
    if (typeof root.name === 'string' && names.has(root.name)) return root.name;
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
