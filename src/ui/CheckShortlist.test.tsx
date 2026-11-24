import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { Snapshot } from '../store';
import { CheckShortlist } from './CheckShortlist';
import { NotebookPanel } from './NotebookPanel';
import { eligibleMarks } from './marks';

function fixture(): Snapshot {
  const snapshot: Snapshot = { paragraphs: [], profile: [], items: [], lineages: [], jobs: [], cards: [] };
  for (let i = 0; i < 4; i++) {
    const paragraph = { id: `p${i}`, projectId: 'default', order: i, text: `Planning statement ${i}`,
      version: 1, updatedAt: 0 };
    snapshot.paragraphs.unshift(paragraph);
    snapshot.items.push({ id: `i${i}`, paragraphId: paragraph.id, paragraphVersion: 1, kind: 'assumption',
      text: `Statement ${i}`, quote: paragraph.text, topics: ['other'], status: 'current',
      promptVersion: 'extract.v2', createdAt: 1, lineageId: `l${i}` });
    snapshot.lineages!.push({ lineageId: `l${i}`, version: 1, itemId: `i${i}`, paragraphId: paragraph.id,
      paragraphVersion: 1, status: 'current' });
    snapshot.jobs.push({ key: `p${i}@1#extract`, paragraphId: paragraph.id, paragraphVersion: 1, step: 'extract',
      promptVersion: 'extract.v2', status: 'done', attempts: 1, createdAt: 1, nextRunAt: 1 });
    snapshot.cards!.push({ id: `c${i}`, paragraphId: paragraph.id, paragraphVersion: 1, itemLineageId: `l${i}`,
      itemVersion: 1, itemText: `Statement ${i}`, itemQuote: paragraph.text, topics: ['other'], angle: 'end-user',
      sourceAngle: 'end-user', concern: 'What is the public requirement?', score: 1, lessonId: null, brief: false,
      sessionId: 's', questionStatus: 'marked', createdAt: 1 });
  }
  return snapshot;
}
it('uses plan order for at most three eligible marks and hides the list without marks', () => {
  const snapshot = fixture();
  expect(eligibleMarks(snapshot).map(mark => mark.item.id)).toEqual(['i0', 'i1', 'i2', 'i3']);
  const render = () => renderToStaticMarkup(<CheckShortlist snapshot={snapshot} view="all" setView={() => {}}
    check={() => {}} />);
  expect(render()).toContain('Worth checking first');
  expect(render()).toContain('Planning statement 0');
  expect(render()).not.toContain('Planning statement 3');
  snapshot.cards![0].supersededMark = true;
  snapshot.lineages![1].status = 'removed';
  snapshot.jobs.find(job => job.paragraphId === 'p2')!.status = 'pending';
  expect(eligibleMarks(snapshot).map(mark => mark.item.id)).toEqual(['i3']);
  snapshot.cards![3].questionStatus = 'waiting';
  expect(render()).not.toContain('Worth checking first');
});
it('switches the statement-view controls and routes the selected item to Check this', () => {
  const snapshot = fixture(); const setView = vi.fn(); const check = vi.fn();
  const tree = CheckShortlist({ snapshot, view: 'all', setView, check });
  const walk = (node: any): any[] => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === 'object'
    ? [node, ...walk(node.props?.children)] : [];
  const buttons = walk(tree).filter(node => node.type === 'button');
  buttons.find(node => node.props.children === 'See all checks').props.onClick();
  buttons.find(node => node.props.children === 'See all statements').props.onClick();
  buttons.find(node => node.props.children === 'Check this').props.onClick();
  expect(setView.mock.calls).toEqual([['checks'], ['all']]);
  expect(check).toHaveBeenCalledWith('i0');
});
it('places a check once beneath its statement and puts removed checks at the end', () => {
  const snapshot = fixture();
  snapshot.paragraphs.sort((a, b) => a.order - b.order);
  snapshot.cards![0].questionStatus = 'ready'; snapshot.cards![0].draftQuestion = 'What is the limit?';
  snapshot.cards![0].triageVersion = 'v2.1';
  snapshot.cards![1].questionStatus = 'ready'; snapshot.cards![1].draftQuestion = 'An older question?';
  snapshot.lineages![1].status = 'removed'; snapshot.items[1].status = 'superseded';
  const html = renderToStaticMarkup(<NotebookPanel text="plan" save={() => {}} storageStatus="saved"
    snapshot={snapshot} configured ready feedback={() => {}} />);
  const firstCard = html.search(/id="check-card-[^"]+-c0"/);
  const earlierCard = html.search(/id="check-card-[^"]+-c1"/);
  expect(html.match(/id="check-card-[^"]+-c0"/g)).toHaveLength(1);
  expect(html.indexOf('Statement 0')).toBeLessThan(firstCard);
  expect(firstCard).toBeLessThan(html.indexOf('Statement 2'));
  expect(html.indexOf('Earlier checks')).toBeLessThan(earlierCard);
  expect(html.match(/Was this question useful\?/g)).toHaveLength(2);
  expect(html).not.toContain('Why this is here');
});
