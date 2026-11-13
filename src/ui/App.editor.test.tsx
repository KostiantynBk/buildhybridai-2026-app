import { PassThrough } from 'node:stream';
import { renderToPipeableStream } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({ notebook: null as unknown, player: null as unknown }));
vi.mock('./service', async importOriginal => ({ ...(await importOriginal<typeof import('./service')>()),
  useForeground: () => true }));
vi.mock('./NotebookPanel', () => ({ NotebookPanel: (props: { save: unknown }) => {
  captured.notebook = props.save; return <div>Notebook mock</div>;
} }));
vi.mock('../eval/SessionPlayerPanel', () => ({ default: (props: { save: unknown }) => {
  captured.player = props.save; return <div>Player mock</div>;
} }));
import App from './App';

it('passes the same normal save handler from App to the notebook and developer player', async () => {
  await new Promise<void>((resolve, reject) => {
    const stream = new PassThrough();
    stream.on('data', () => {});
    stream.on('end', resolve);
    stream.on('error', reject);
    const rendering = renderToPipeableStream(<App developerPlayer />, {
      onAllReady: () => rendering.pipe(stream), onError: reject,
    });
  });
  expect(typeof captured.notebook).toBe('function');
  expect(captured.player).toBe(captured.notebook);
});
