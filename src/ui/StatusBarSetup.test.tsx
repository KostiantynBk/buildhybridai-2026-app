import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { LocalModelService } from '../ai/localModel';
import { chromeSetup } from './copy';

const h = vi.hoisted(() => {
  let values: unknown[] = []; let index = 0;
  return { reset() { values = []; index = 0; }, begin() { index = 0; },
    useState<T>(initial: T) { const i = index++; if (!(i in values)) values[i] = initial;
      return [values[i], (value: T | ((old: T) => T)) => {
        values[i] = typeof value === 'function' ? (value as (old: T) => T)(values[i] as T) : value;
      }] as const; } };
});
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: h.useState }));
import { StatusBar } from './StatusBar';
function nodes(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element, ...nodes(element.props.children)];
}
it('opens the existing Chrome setup instructions', () => {
  h.reset();
  const service = { state: { kind: 'ready' }, browserAvailability: 'available', preparing: false,
    retryRequired: false, warmLatencyMs: null, privacyFaults: 0 } as unknown as LocalModelService;
  const render = () => { h.begin(); return StatusBar({ service, configured: true, foreground: true }); };
  const button = nodes(render()).find(element => element.type === 'button' &&
    (element.props as { children?: string }).children === 'Tested with Gemma 4 — how to enable it')!;
  (button.props as { onClick(): void }).onClick();
  const html = renderToStaticMarkup(render());
  for (const step of chromeSetup) expect(html).toContain(step);
});
