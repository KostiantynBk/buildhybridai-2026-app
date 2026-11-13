/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { expect, it } from 'vitest';

it('keeps settings and Remote Config outside the guarded local model service and adapter', () => {
  for (const name of ['../ai/localModel.ts', '../ai/firebase.ts']) {
    const source = readFileSync(new URL(name, import.meta.url), 'utf8');
    expect(source).not.toMatch(/(?:from\s*|import\s*\()['"][^'"]*(?:settings|remote-config)/);
  }
});
it('excludes remote settings, Remote Config and Installations from the transitive eval graph', async () => {
  const result = await build({
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      emptyOutDir: false,
      minify: false,
      rollupOptions: { input: fileURLToPath(new URL('../eval/EvalPage.tsx', import.meta.url)),
        treeshake: false },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const modules = outputs.flatMap(output => {
    if (!('output' in output)) throw new Error('Expected a completed in-memory build');
    return output.output.flatMap(chunk => chunk.type === 'chunk' ? Object.keys(chunk.modules) : []);
  });
  expect(modules.some(path => path.includes('/eval/EvalPage.tsx'))).toBe(true);
  expect(modules.filter(path => /remoteSettings|remote-config|installations/i.test(path))).toEqual([]);
}, 30000);

it('keeps the evaluation startup and runner independent of remote settings', () => {
  for (const name of ['../eval/EvalPage.tsx', '../eval/runner.ts', '../ui/service.ts']) {
    const source = readFileSync(new URL(name, import.meta.url), 'utf8');
    expect(source).not.toMatch(/(?:from\s*|import\s*\()['"][^'"]*(?:remoteSettings|remote-config)/);
  }
});
