// This module is imported only through a compile-time DEV gate.
export function enableDevelopmentAppCheckDebug(): void {
  console.info('THOUGHTPARTNER_DEV_APPCHECK_ONLY');
  (self as typeof self & { FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
}
