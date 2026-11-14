import { expect, it } from 'vitest';
import { runEvaluation, type RunMode } from './runner';
import { promptFor, prompts, sizeInCharacters } from './playground';
import { extractInput, type ExtractVersion, type LocalRunner } from '../pipeline/extract';
import { extractV1 } from '../pipeline/prompts/extract.v1';
import { extractV2 } from '../pipeline/prompts/extract.v2';
import { anglesV2 } from '../pipeline/prompts/angles.v2';
import { questionV2 } from '../pipeline/prompts/question.v2';
import { whynoteV2 } from '../pipeline/prompts/whynote.v2';
import notes from '../../eval/set-v1/notes.json';

it.each<RunMode>(['run1', 'latency'])(
  'uses the selected v2 version for every %s call and export row',
  async (mode) => {
    const seen: unknown[] = [];
    const runner: LocalRunner = async <T>(job: Parameters<LocalRunner>[0]) => {
      seen.push(job.instructions);
      return { data: { items: [] } as T, latencyMs: 1, source: 'on_device', raw: '{"items":[]}' };
    };
    const options: Parameters<typeof runEvaluation>[0] = {
      mode,
      runner,
      warmupLatencyMs: 0,
      onDeviceModel: 'synthetic',
      promptVersion: 'extract.v2',
      signal: new AbortController().signal,
      rest: async () => {},
    };
    options.onUpdate = () => {
      options.promptVersion = 'extract.v1';
    };
    const result = await runEvaluation(options);
    expect(result.complete).toBe(true);
    expect(result.environment.promptVersion).toBe('extract.v2');
    expect(result.rows.every((row) => row.promptVersion === 'extract.v2')).toBe(true);
    expect(seen.every((value) => value === extractV2)).toBe(true);
    expect(result.rows[0].inputSize).toBe(
      sizeInCharacters(
        'extract',
        extractInput(
          notes.notes[0].title,
          result.rows[0].sampleKind === 'run1'
            ? notes.notes[0].text
            : Array.from(
                { length: 200 },
                (_, i) =>
                  notes.notes[0].text.split(/\s+/)[i % notes.notes[0].text.split(/\s+/).length],
              ).join(' '),
        ),
        'extract.v2',
      ),
    );
  },
);
it('keeps v1 and v2 template/schema identical while sizing the second example', () => {
  const input = extractInput(notes.notes[0].title, notes.notes[0].text);
  expect(promptFor('extract', 'extract.v2')).toBe(extractV2);
  expect(promptFor('compare', 'extract.v2')).toBe(prompts.compare);
  expect(promptFor('angles', 'extract.v2')).toBe(anglesV2);
  expect(promptFor('question', 'extract.v2')).toBe(questionV2);
  expect(promptFor('whynote', 'extract.v2')).toBe(whynoteV2);
  expect(extractV2.schema).toBe(extractV1.schema);
  expect(extractV2.inputTemplate).toBe(extractV1.inputTemplate);
  expect(sizeInCharacters('extract', input, 'extract.v1')).toBe(3356);
  expect(sizeInCharacters('extract', input, 'extract.v2')).toBe(4022);
  const version: ExtractVersion = 'extract.v1';
  expect(sizeInCharacters('extract', input, version)).toBe(sizeInCharacters('extract', input));
});
