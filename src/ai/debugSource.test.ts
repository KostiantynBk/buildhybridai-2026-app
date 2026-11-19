import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('keeps the application debug global in the single DEV-gated module', () => {
  const marker = ['FIREBASE', 'APPCHECK', 'DEBUG', 'TOKEN'].join('_');
  const matches: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (readFileSync(path, 'utf8').includes(marker)) matches.push(path.replaceAll('\\', '/'));
    }
  };
  walk('src');
  expect(matches).toEqual(['src/ai/debugDev.ts']);
  const dev = readFileSync('src/ai/debugDev.ts', 'utf8');
  const initializer = readFileSync('src/ai/firebase.ts', 'utf8');
  expect(dev).toContain('THOUGHTPARTNER_DEV_APPCHECK_ONLY');
  expect(initializer).toContain('if (import.meta.env.DEV && config.dev && config.debug)');
  expect(initializer).toContain('enableDevelopmentAppCheckDebug()');
});
