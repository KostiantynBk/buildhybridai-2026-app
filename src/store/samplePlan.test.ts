import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { openLocalStore, SampleChangedError } from './index';
import { samplePlan } from '../ui/samplePlan';

it('loads the invented sample only into an empty notebook and leaves privacy/profile unchanged', async () => {
  const name = `sample-${crypto.randomUUID()}`;
  const store = await openLocalStore(name); const other = await openLocalStore(name);
  try {
    await store.putProfile({ id: 'skill', type: 'skill', text: 'Existing profile', topics: [], tags: [],
      updatedAt: 1 });
    await store.putNeverSend(['Private term']);
    const values = samplePlan.join('\n\n');
    const results = await Promise.all([store.loadSampleIfEmpty(values, 10), other.loadSampleIfEmpty('other text', 10)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const snapshot = await store.snapshot();
    expect(snapshot.profile[0].text).toBe('Existing profile');
    expect(snapshot.neverSend).toEqual(['Private term']);
    if (results[0]) expect(snapshot.paragraphs.map(value => value.text)).toEqual([...samplePlan]);
    else expect(snapshot.paragraphs[0].text).toBe('other text');
    expect(await store.loadSampleIfEmpty(values)).toBe(false);
    expect((await store.snapshot()).paragraphs.map(value => value.text)).toEqual(snapshot.paragraphs.map(p => p.text));
  } finally { store.close(); other.close(); }
});

it('checks all displayed revisions in the clearing transaction', async () => {
  const name = `sample-remove-${crypto.randomUUID()}`;
  const store = await openLocalStore(name); const other = await openLocalStore(name);
  try {
    await store.loadSampleIfEmpty(samplePlan.join('\n\n'));
    const expected = (await store.snapshot()).paragraphs.map(({ id, version }) => ({ id, version }));
    await other.saveNotebook(`${samplePlan[0]} Edited.\n\n${samplePlan.slice(1).join('\n\n')}`);
    const afterEdit = await store.snapshot();
    await expect(store.saveNotebook('', Date.now(), expected)).rejects.toBeInstanceOf(SampleChangedError);
    expect((await store.snapshot()).paragraphs).toEqual(afterEdit.paragraphs);
    const updated = afterEdit.paragraphs.map(({ id, version }) => ({ id, version }));
    await store.saveNotebook('', Date.now(), updated);
    expect((await store.snapshot()).paragraphs).toHaveLength(0);
  } finally { store.close(); other.close(); }
});
