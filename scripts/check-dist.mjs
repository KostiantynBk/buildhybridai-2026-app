import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? 'dist';
const manifest = JSON.parse(readFileSync(new URL('../src/eval/runner-markers.json', import.meta.url), 'utf8'));
const forbidden = ['VITE_APPCHECK_DEBUG', 'THOUGHTPARTNER_DEV_APPCHECK_ONLY', 'EvalPage', 'SessionPlayer',
  'run1', 'run2', 'run3', 'run4',
  'Run1', 'Run2', 'Run3', 'Run4', ...Object.values(manifest).flat()];
const debugGlobal = 'FIREBASE_APPCHECK_DEBUG_TOKEN';
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const assignment = /FIREBASE_APPCHECK_DEBUG_TOKEN['"]?\s*\]?\s*(?:\+=|\?\?=|\|\|=|&&=|=(?!=))/;
const publicEnv = new Set(['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_APP_ID', 'VITE_RECAPTCHA_ENTERPRISE_SITE_KEY']);
const sdkPath = 'node_modules/@firebase/app-check/dist/esm/index.esm.js';
let occurrences = 0;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { walk(path); continue; }
    const content = readFileSync(path, 'utf8');
    const envNames = content.match(/VITE_[^\s'"`:;,=()[\]{}<>]*/gi) ?? [];
    if (forbidden.some(marker => content.includes(marker)) || uuid.test(content) || assignment.test(content) ||
        envNames.some(name => !publicEnv.has(name))) {
      throw new Error(`Forbidden production marker in ${path}`);
    }
    occurrences += content.split(debugGlobal).length - 1;
  }
}
try {
  let sdk;
  try { sdk = readFileSync(sdkPath, 'utf8'); } catch {
    throw new Error(`Cannot verify App Check SDK: missing ${sdkPath}`);
  }
  const sdkCount = sdk.split(debugGlobal).length - 1;
  walk(root);
  if (occurrences > sdkCount) throw new Error('Unexpected App Check debug-global references in production output.');
  console.log('Production artifact check passed.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Production artifact check failed.');
  process.exitCode = 1;
}
