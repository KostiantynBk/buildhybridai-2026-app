import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { navigationItems } from './navigation';

const css = readFileSync('src/ui/style.css', 'utf8');
function colour(name: string): string {
  const value = css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];
  if (!value) throw new Error(`Missing ${name} token.`);
  return value;
}
function luminance(hex: string): number {
  const channels = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrast(first: string, second: string): number {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
it('keeps text and primary action token contrast at WCAG AA levels', () => {
  for (const name of ['ink', 'subtle', 'placeholder']) {
    expect(contrast(colour(name), colour('surface'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colour(name), colour('background'))).toBeGreaterThanOrEqual(4.5);
  }
  expect(contrast(colour('accent'), colour('surface'))).toBeGreaterThanOrEqual(4.5);
  expect(contrast(colour('control-border'), colour('surface'))).toBeGreaterThanOrEqual(3);
  expect(contrast(colour('control-border'), colour('background'))).toBeGreaterThanOrEqual(3);
  expect(css).toContain(':focus-visible');
  expect(css).toContain('prefers-reduced-motion: reduce');
});
it('keeps Insights in development navigation only', () => {
  expect(navigationItems(false)).not.toContain('Insights');
  expect(navigationItems(true)).toContain('Insights');
});
it('removes old conflicting visible UI copy', () => {
  const old = ['Preparing your question', 'Preparing your description', 'No automatic cloud fallback is used',
    'An extraction stopped after bounded retries', 'Waiting for the paragraph to settle',
    'Legacy question awaiting a decision', 'Approved, not sent. Research in progress'];
  for (const file of readdirSync('src/ui').filter(value => value.endsWith('.tsx') && !value.includes('.test.'))) {
    const text = readFileSync(`src/ui/${file}`, 'utf8');
    for (const phrase of old) expect(text, `${file}: ${phrase}`).not.toContain(phrase);
  }
});
