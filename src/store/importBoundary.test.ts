/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { expect, it } from 'vitest';

async function graph(paths: string[]): Promise<string[]> {
  const output = await build({ configFile: false, envFile: false, logLevel: 'silent',
    build: { write: false, emptyOutDir: false, minify: false,
      rollupOptions: { input: paths.map(path => fileURLToPath(new URL(path, import.meta.url))), treeshake: false } } });
  const results = Array.isArray(output) ? output : [output];
  return results.flatMap(result => {
    if (!('output' in result)) throw new Error('Expected an in-memory bundle.');
    return result.output.flatMap(chunk => chunk.type === 'chunk' ? Object.keys(chunk.modules) : []);
  });
}
it('keeps store, notebook and profile modules free of Firebase imports', async () => {
  const modules = await graph(['./index.ts', '../ui/NotebookPanel.tsx', '../profile/ProfilePanel.tsx']);
  expect(modules.some(path => path.includes('/store/index.ts'))).toBe(true);
  expect(modules.filter(path => /node_modules\/(?:@firebase|firebase)\//i.test(path))).toEqual([]);
}, 30000);
it('keeps the profile out of the extraction scheduler prompt graph', async () => {
  const modules = await graph(['./scheduler.ts']);
  expect(modules.some(path => path.includes('/pipeline/extract.ts'))).toBe(true);
  expect(modules.filter(path => /\/profile\//i.test(path))).toEqual([]);
}, 30000);
