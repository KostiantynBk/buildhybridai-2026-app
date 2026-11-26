import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { Snapshot } from '../store';
import { NotebookPanel } from './NotebookPanel';
import { CheckShortlist } from './CheckShortlist';
import { eligibleMarks } from './marks';

function fixture(): Snapshot {
  const snapshot: Snapshot = { paragraphs: [], items: [], profile: [], jobs: [], lineages: [], cards: [] };
  for (let i = 0; i < 4; i++) {
    const paragraph = { id: `p${i}`, projectId: 'default', order: i,
      text: `Fictional planning statement number ${i}`, version: 1, updatedAt: 0 };
    snapshot.paragraphs.push(paragraph);
    snapshot.items.push({ id: `i${i}`, paragraphId: paragraph.id, paragraphVersion: 1, kind: 'assumption',
      text: `Statement ${i}`, quote: paragraph.text, topics: [], status: 'current', promptVersion: 'extract.v2',
      createdAt: 1, lineageId: `l${i}` });
    snapshot.lineages!.push({ lineageId: `l${i}`, version: 1, itemId: `i${i}`, paragraphId: paragraph.id,
      paragraphVersion: 1, status: 'current' });
    snapshot.jobs.push({ key: `p${i}@1#extract`, paragraphId: paragraph.id, paragraphVersion: 1, step: 'extract',
      promptVersion: 'extract.v2', status: 'done', attempts: 1, createdAt: 1, nextRunAt: 1 });
    snapshot.cards!.push({ id: `c${i}`, paragraphId: paragraph.id, paragraphVersion: 1, itemLineageId: `l${i}`,
      itemVersion: 1, itemText: `Statement ${i}`, itemQuote: paragraph.text, topics: [], angle: 'end-user',
      sourceAngle: 'end-user', concern: 'A fictional concern for testing.', score: 1, lessonId: null, brief: false,
      sessionId: 's', questionStatus: i === 3 ? 'ready' : 'marked',
      ...(i === 3 ? { draftQuestion: 'A fictional question?' } : {}), createdAt: 1 });
  }
  for (const [id, status] of [['old-unchecked', 'current'], ['old-removed', 'removed']] as const) {
    snapshot.items.push({ ...snapshot.items[0], id, text: id, paragraphId: id, lineageId: `l-${id}` });
    snapshot.lineages!.push({ lineageId: `l-${id}`, version: 1, itemId: id, paragraphId: id, paragraphVersion: 1,
      status, ...(status === 'current' ? { unchecked: true } : {}) });
  }
  return snapshot;
}
type Status = 'saved' | 'saving' | 'loading' | 'error';
function renderPanel(snapshot: Snapshot, storageStatus: Status) {
  return renderToStaticMarkup(<NotebookPanel text="fictional draft" save={() => {}} storageStatus={storageStatus}
    snapshot={snapshot} configured ready checkThis={async () => {}} sendDraft={async () => {}} />);
}
function renderShortlist(snapshot: Snapshot, status: Status) {
  return renderToStaticMarkup(<CheckShortlist snapshot={snapshot} view="all" setView={() => {}} check={() => {}}
    selectedMarks={eligibleMarks(snapshot)} chosen showMarks={status === 'saved' || status === 'saving'}
    saving={status === 'saving'} disabled={status !== 'saved'} />);
}
it('keeps statements, cards, historical lists and chosen shortlist visible but inert while saving', () => {
  const snapshot = fixture();
  const saved = renderPanel(snapshot, 'saved');
  const saving = renderPanel(snapshot, 'saving');
  for (const text of ['Statement 0', 'Statement 3', 'A fictional question?', 'old-unchecked', 'old-removed']) {
    expect(saved).toContain(text); expect(saving).toContain(text);
  }
  expect(saving).toContain('class="panel thoughts" inert="" aria-busy="true"');
  expect(saving).not.toMatch(/<section hidden=""><h3>/);
  expect(saved).not.toContain('class="panel thoughts" inert=');
  const savedShortlist = renderShortlist(snapshot, 'saved');
  const savingShortlist = renderShortlist(snapshot, 'saving');
  for (let i = 0; i < 3; i++) {
    expect(savedShortlist).toContain(`Fictional planning statement number ${i}`);
    expect(savingShortlist).toContain(`Fictional planning statement number ${i}`);
  }
  expect(savingShortlist).toContain('Chosen on this device');
  expect(savingShortlist).toContain('class="panel check-shortlist" inert=""');
  expect(savingShortlist.match(/<li>/g)).toHaveLength(3);
});
it.each(['loading', 'error'] as const)('keeps previous hidden and shortlist behavior during %s', status => {
  const snapshot = fixture();
  const panel = renderPanel(snapshot, status); const shortlist = renderShortlist(snapshot, status);
  expect(panel).toMatch(/<section hidden=""><h3>/);
  expect(panel).not.toContain('old-unchecked'); expect(panel).not.toContain('old-removed');
  expect(panel).not.toContain('class="panel thoughts" inert=');
  expect(shortlist).not.toContain('Worth checking first');
  expect(shortlist).not.toContain('Chosen on this device');
  expect(shortlist).not.toContain('inert=');
});
it('keeps existing checks-only filtering while saving', () => {
  const snapshot = fixture();
  const html = renderToStaticMarkup(<NotebookPanel text="fake" save={() => {}} storageStatus="saving"
    snapshot={snapshot} configured ready checksOnly />);
  expect(html).toContain('Statement 0');
  expect(html).not.toContain('old-removed'); expect(html).not.toContain('old-unchecked');
  expect(html).toContain('class="panel thoughts" inert=""');
});
it('refuses retained shortlist handlers while saving and allows them once saved', () => {
  const snapshot = fixture(); const check = vi.fn(); const setView = vi.fn();
  const walk = (node: any): any[] => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === 'object'
    ? [node, ...walk(node.props?.children)] : [];
  const render = (saving: boolean) => CheckShortlist({ snapshot, view: 'all', check, setView, saving,
    disabled: saving });
  const actions = (saving: boolean) => walk(render(saving)).filter(node => node.type === 'button');
  actions(true).find(node => node.props.children === 'Check this').props.onClick();
  actions(true).find(node => node.props.children === 'See all checks').props.onClick();
  expect(check).not.toHaveBeenCalled(); expect(setView).not.toHaveBeenCalled();
  actions(false).find(node => node.props.children === 'Check this').props.onClick();
  actions(false).find(node => node.props.children === 'See all checks').props.onClick();
  expect(check).toHaveBeenCalledOnce(); expect(setView).toHaveBeenCalledWith('checks');
});
it('uses delivered snapshot names while saving and live editor names when interactive', () => {
  const snapshot = fixture();
  snapshot.cards![3].draftQuestion = 'Can guests ask Mina Rosa for help?';
  const withoutName = 'A fictional plan for a public booking service.';
  const withName = 'A fictional plan with Mina Rosa for a public booking service.';
  snapshot.paragraphs[3].text = withoutName;
  const render = (status: Status, text: string) => renderToStaticMarkup(<NotebookPanel text={text} save={() => {}}
    storageStatus={status} snapshot={snapshot} configured ready sendDraft={async () => {}} />);
  expect(render('saving', withName)).not.toContain('Not private: Mina Rosa');
  expect(render('saved', withName)).toContain('Not private: Mina Rosa');
  snapshot.paragraphs[3].text = withName;
  expect(render('saving', withoutName)).toContain('Not private: Mina Rosa');
  expect(render('saved', withoutName)).not.toContain('Not private: Mina Rosa');
});
