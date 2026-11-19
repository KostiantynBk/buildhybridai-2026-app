import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const root = process.argv[2] ?? 'dist';
const manifest = JSON.parse(readFileSync(new URL('../src/eval/runner-markers.json', import.meta.url), 'utf8'));
const forbidden = ['VITE_APPCHECK_DEBUG', 'EvalPage', 'SessionPlayer', 'run1', 'run2', 'run3', 'run4',
  'Run1', 'Run2', 'Run3', 'Run4', ...Object.values(manifest).flat()];
const debugGlobal = 'FIREBASE_APPCHECK_DEBUG_TOKEN';
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const assignment = /FIREBASE_APPCHECK_DEBUG_TOKEN['"]?\s*\]?\s*=(?!=)/;
const publicEnv = new Set(['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_APP_ID', 'VITE_RECAPTCHA_ENTERPRISE_SITE_KEY']);
const allowedContexts = new Set([
  '0ecde6781bef778b87944f6a6266ca0ef67c4db856e157431a691ff45e902597',
  '0202509321021d51240a234022f82dbb9a2c9769adf0a58ade9d820efd52da4f',
  '08b5edf8f21f958b33776fb9c57285ecfeecbf2775fa475c16c110faf13a5c7b',
  'd2358adb9dd6173997ed286a5ff199b90548ff21a42edfab13f01e8b84f3baa8',
]);
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
    for (const occurrence of content.matchAll(new RegExp(debugGlobal, 'g'))) {
      const at = occurrence.index;
      const context = content.slice(Math.max(0, at - 40), at + debugGlobal.length + 40);
      const hash = createHash('sha256').update(context).digest('hex');
      if (!allowedContexts.delete(hash)) throw new Error(`Unexpected App Check debug-global use in ${path}`);
    }
  }
}
try {
  walk(root);
  console.log('Production artifact check passed.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Production artifact check failed.');
  process.exitCode = 1;
}
