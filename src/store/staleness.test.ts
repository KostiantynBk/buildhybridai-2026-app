import { expect, it } from 'vitest';
import { calculateStaleness } from './staleness';
import type { Dependency, LineageVersion } from './index';

const version = (lineageId: string, number: number, status: LineageVersion['status'],
  needsConfirmation = false): LineageVersion => ({ lineageId, version: number, itemId: `i${number}`,
  paragraphId: 'p', paragraphVersion: number, status, needsConfirmation });
it('reports changes, removals and uncertain changes across multiple dependencies', () => {
  const dependencies: Dependency[] = ['a', 'b', 'c', 'd'].map(lineageId => ({ consumerId: 'card', lineageId,
    version: 1 }));
  const versions = [version('a', 1, 'current'), version('a', 2, 'changed'), version('b', 1, 'current'),
    version('b', 2, 'removed'), version('c', 1, 'current'), version('c', 2, 'changed', true),
    version('d', 1, 'current')];
  expect(calculateStaleness('card', dependencies, versions)).toEqual({ stale: true, reasons: [
    { lineageId: 'a', was: 1, now: 2, kind: 'changed' },
    { lineageId: 'b', was: 1, now: 2, kind: 'removed' },
    { lineageId: 'c', was: 1, now: 2, kind: 'needsConfirmation' },
  ] });
  expect(calculateStaleness('other', dependencies, versions)).toEqual({ stale: false, reasons: [] });
  expect(calculateStaleness('card', [{ consumerId: 'card', lineageId: 'd', version: 1 }], versions))
    .toEqual({ stale: false, reasons: [] });
  expect(calculateStaleness('card', [{ consumerId: 'card', lineageId: 'c', version: 1 }],
    [...versions, version('c', 3, 'changed')])).toEqual({ stale: true, reasons: [
      { lineageId: 'c', was: 1, now: 3, kind: 'changed' },
    ] });
});
