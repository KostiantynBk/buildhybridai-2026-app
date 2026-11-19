import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { researchError } from './ai/researchFlow';
import { developerRoute } from './ui/route';

it('has SPA routing, cache controls and report-only security headers', () => {
  const config = JSON.parse(readFileSync('firebase.json', 'utf8'));
  expect(config.hosting.public).toBe('dist');
  expect(config.hosting.rewrites).toContainEqual({ source: '**', destination: '/index.html' });
  const headers = config.hosting.headers as Array<{ source?: string; regex?: string;
    headers: Array<{ key: string; value: string }> }>;
  const all = headers.find(value => value.source === '**')!.headers;
  const csp = all.find(value => value.key === 'Content-Security-Policy-Report-Only')!.value;
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain("'unsafe-eval'");
  for (const key of ['X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy']) {
    expect(all.some(value => value.key === key)).toBe(true);
  }
  const effectiveCache = (path: string) => headers.filter(rule => rule.source === '**' ||
    (rule.regex && new RegExp(rule.regex).test(path))).flatMap(rule => rule.headers)
    .filter(header => header.key === 'Cache-Control').at(-1)?.value;
  for (const path of ['/', '/index.html', '/dev', '/eval', '/nested/route']) {
    expect(effectiveCache(path)).toBe('no-cache');
  }
  expect(effectiveCache('/assets/index-B2_3AwO9.js')).toContain('immutable');
  expect(effectiveCache('/assets/missing.js')).toBe('no-cache');
});
it('routes eval and dev paths to the normal app in production', () => {
  expect(developerRoute('/eval', false)).toBe('app');
  expect(developerRoute('/dev', false)).toBe('app');
  expect(developerRoute('/eval', true)).toBe('eval');
  expect(developerRoute('/dev', true)).toBe('dev');
});
it('rejects token-shaped and developer artifacts while accepting a clean fixture', () => {
  const dir = mkdtempSync(join(tmpdir(), 'thoughtpartner-dist-'));
  try {
    const file = join(dir, 'bundle.js');
    writeFileSync(file, 'clean production fixture');
    execFileSync(process.execPath, ['scripts/check-dist.mjs', dir]);
    for (const content of ['VITE_APPCHECK_DEBUG', 'VITE_UNEXPECTED_SECRET', 'vite_Unlisted', 'VITE_',
      'VITE_FIREBASE_API_KEY.notes', 'VITE_FIREBASE_API_KEY-extra', 'VITE_FIREBASE_API_KEYé',
      'VITE_FIREBASE_API_KEY$fixture', 'VITE_FIREBéASE_API_KEY', 'VITE_FIRE$BASE_API_KEY',
      'EvalPage', 'SessionPlayer',
      'runEvaluation', 'runChangeEvaluation', 'runGate2',
      '_12345678-1234-1234-1234-123456789abc_', 'self.FIREBASE_APPCHECK_DEBUG_TOKEN=true',
      'self["FIREBASE_APPCHECK_DEBUG_TOKEN"]=true', 'other.FIREBASE_APPCHECK_DEBUG_TOKEN',
      Array(4).fill('sdk.FIREBASE_APPCHECK_DEBUG_TOKEN').join(';')]) {
      writeFileSync(file, content);
      expect(spawnSync(process.execPath, ['scripts/check-dist.mjs', dir]).status).toBe(1);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('resolves deploy project using production Vite dotenv semantics', () => {
  const dir = mkdtempSync(join(tmpdir(), 'thoughtpartner-env-'));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('VITE_')) delete env[key];
  const select = () => execFileSync(process.execPath, ['--input-type=module', '-e',
    "import {deploymentProject} from './scripts/project-env.mjs'; console.log(deploymentProject(process.argv[1]));",
    dir], { env, encoding: 'utf8' }).trim();
  try {
    for (const content of ['export VITE_FIREBASE_PROJECT_ID=fixture-beta',
      'VITE_FIREBASE_PROJECT_ID=fixture-beta # comment',
      'VITE_FIREBASE_PROJECT_ID=fixture-alpha\nexport VITE_FIREBASE_PROJECT_ID=fixture-beta # comment']) {
      writeFileSync(join(dir, '.env.local'), content);
      expect(select()).toBe('fixture-beta');
    }
    writeFileSync(join(dir, '.env.local'), 'VITE_FIREBASE_PROJECT_ID=BAD!');
    expect(() => select()).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('lists every runner export beside the runner source', () => {
  const manifest = JSON.parse(readFileSync('src/eval/runner-markers.json', 'utf8')) as Record<string, string[]>;
  for (const [file, names] of Object.entries(manifest)) {
    const text = readFileSync(`src/eval/${file}`, 'utf8');
    const exports = [...text.matchAll(/export (?:async )?(?:function|const|class) (\w+)/g)]
      .map(value => value[1]);
    expect(names.sort()).toEqual(exports.sort());
  }
});
it.each([
  [{ customErrorData: { status: 429 } }, 'quota'],
  [{ customErrorData: { status: 429, errorDetails: [{ reason: 'RESOURCE_EXHAUSTED' }] } }, 'quota'],
  [{ customErrorData: { status: 403, errorDetails: [{ reason: 'BILLING_DISABLED' }] } }, 'billing'],
  [{ customErrorData: { status: 401 } }, 'permission'],
  [{ customErrorData: { status: 403 } }, 'permission'],
  [{ message: 'Request blocked by policy', customErrorData: { status: 401 } }, 'permission'],
  [{ message: 'Request blocked by policy', customErrorData: { status: 403 } }, 'permission'],
  [{ message: 'billingProject', customErrorData: { status: 403, errorDetails: [{ reason: 'PERMISSION_DENIED' }] } },
    'permission'],
  [{ message: 'no billing status', customErrorData: { status: 400 } }, 'unknown'],
])('classifies known quota or ambiguous refusal without retrying', (error, code) => {
  const result = researchError(error);
  expect(result.code).toBe(code);
  expect(result.network).toBe(false);
  expect(result.message).toContain(code === 'permission' ? 'cloud refused' : code === 'billing'
    ? 'billing is unavailable' : code === 'quota' ? 'cloud budget is used up' : 'could not be completed');
});
