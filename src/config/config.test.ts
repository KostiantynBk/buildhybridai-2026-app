/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXAMPLE_PLACEHOLDERS, readConfig } from './index';

const valid = {
  VITE_FIREBASE_API_KEY: 'example-key',
  VITE_FIREBASE_AUTH_DOMAIN: 'example.invalid',
  VITE_FIREBASE_PROJECT_ID: 'example',
  VITE_FIREBASE_APP_ID: 'example-app',
  VITE_RECAPTCHA_ENTERPRISE_SITE_KEY: 'example-site',
};

describe('example placeholders', () => {
  it('matches the checked-in example and rejects every placeholder value', () => {
    const content = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
    const entries = Object.fromEntries(
      content
        .trim()
        .split(/\r?\n/)
        .map((line) => {
          const position = line.indexOf('=');
          return [line.slice(0, position), line.slice(position + 1)];
        }),
    );
    const { VITE_APPCHECK_DEBUG, ...placeholders } = entries;
    expect(VITE_APPCHECK_DEBUG).toBe('false');
    expect(placeholders).toEqual(EXAMPLE_PLACEHOLDERS);
    for (const [field, value] of Object.entries(placeholders)) {
      expect(readConfig({ ...valid, [field]: value })).toBeNull();
    }
  });
  it.each(['your-startup', 'replacement-tools', 'placeholder-labs'])(
    'accepts legitimate project %s',
    (name) => {
      const result = readConfig({
        ...valid,
        VITE_FIREBASE_PROJECT_ID: name,
        VITE_FIREBASE_AUTH_DOMAIN: `${name}.firebaseapp.com`,
      });
      expect(result?.projectId).toBe(name);
      expect(result?.authDomain).toBe(`${name}.firebaseapp.com`);
    },
  );
});
