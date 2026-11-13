/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('keeps settings and Remote Config outside the guarded local model service and adapter', () => {
  for (const name of ['../ai/localModel.ts', '../ai/firebase.ts']) {
    const source = readFileSync(new URL(name, import.meta.url), 'utf8');
    expect(source).not.toMatch(/(?:from\s*|import\s*\()['"][^'"]*(?:settings|remote-config)/);
  }
});
it('keeps the evaluation startup and runner independent of remote settings', () => {
  for (const name of ['../eval/EvalPage.tsx', '../eval/runner.ts', '../ui/service.ts']) {
    const source = readFileSync(new URL(name, import.meta.url), 'utf8');
    expect(source).not.toMatch(/(?:from\s*|import\s*\()['"][^'"]*(?:remoteSettings|remote-config)/);
  }
});
