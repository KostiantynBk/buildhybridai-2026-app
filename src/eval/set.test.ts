import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import notesFile from '../../eval/set-v1/notes.json';
import changesFile from '../../eval/set-v1/changes.json';
import profilesFile from '../../eval/set-v1/profiles.json';
import examples from '../../eval/set-v1/dev-examples.json';

const topics = profilesFile.topics;
const angles = [
  'end-user',
  'cost-at-scale',
  'limits-operations',
  'security-privacy',
  'alternatives',
];
const schema = {
  type: 'object',
  required: ['version', 'notes'],
  additionalProperties: false,
  properties: {
    version: { const: 'set-v1' },
    notes: {
      type: 'array',
      minItems: 20,
      maxItems: 20,
      items: {
        type: 'object',
        required: ['id', 'title', 'text', 'expected', 'blindSpots', 'privateTokens'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', pattern: '^n[0-9]{2}$' },
          title: { type: 'string' },
          text: { type: 'string' },
          expected: {
            type: 'array',
            maxItems: 4,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'span', 'topics'],
              properties: {
                kind: { enum: ['assumption', 'decision', 'constraint', 'open-question'] },
                span: { type: 'string' },
                topics: { type: 'array', minItems: 1, maxItems: 3, items: { enum: topics } },
              },
            },
          },
          blindSpots: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['angle', 'description', 'questionKeywords'],
              properties: {
                angle: { enum: angles },
                description: { type: 'string' },
                questionKeywords: { type: 'array', minItems: 1, items: { type: 'string' } },
              },
            },
          },
          privateTokens: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};
const changeSchema = {
  type: 'object',
  required: ['version', 'changes'],
  additionalProperties: false,
  properties: {
    version: { const: 'changes-v1' },
    changes: {
      type: 'array',
      minItems: 6,
      maxItems: 6,
      items: {
        type: 'object',
        required: ['noteId', 'editedText', 'expectedChanged', 'targetSpan', 'changeDescription'],
        additionalProperties: false,
        properties: {
          noteId: { type: 'string' },
          editedText: { type: 'string' },
          expectedChanged: { type: 'boolean' },
          targetSpan: { type: 'string', minLength: 1 },
          changeDescription: { type: 'string', minLength: 1 },
        },
      },
    },
  },
};

describe('versioned synthetic set', () => {
  it('matches its JSON schemas and exact span, count, topic and angle invariants', () => {
    const ajv = new Ajv();
    expect(ajv.validate(schema, notesFile)).toBe(true);
    expect(ajv.validate(changeSchema, changesFile)).toBe(true);
    const profileSchema = {
      type: 'object',
      required: ['version', 'profiles'],
      properties: {
        version: { const: 'profiles-v1' },
        profiles: {
          type: 'object',
          required: ['A', 'B'],
          additionalProperties: false,
          properties: Object.fromEntries(
            ['A', 'B'].map((id) => [
              id,
              {
                type: 'object',
                required: ['summary', 'privateTokens', 'records'],
                properties: {
                  summary: { type: 'string' },
                  privateTokens: { type: 'array', items: { type: 'string' } },
                  records: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['id', 'type', 'text', 'topics'],
                      properties: {
                        id: { type: 'string' },
                        type: { enum: ['skill', 'project', 'lesson', 'preference'] },
                        text: { type: 'string' },
                        topics: { type: 'array', items: { enum: topics } },
                      },
                    },
                  },
                },
              },
            ]),
          ),
        },
      },
    };
    const practiceSchema = {
      type: 'object',
      required: ['version', 'examples'],
      properties: {
        version: { const: 'dev-examples-v1' },
        examples: {
          type: 'array',
          minItems: 3,
          maxItems: 3,
          items: {
            type: 'object',
            required: ['id', 'title', 'text', 'expected', 'blindSpots', 'privateTokens'],
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              text: { type: 'string' },
              expected: { type: 'array' },
              blindSpots: { type: 'array' },
              privateTokens: { type: 'array' },
            },
          },
        },
      },
    };
    expect(ajv.validate(profileSchema, profilesFile)).toBe(true);
    expect(ajv.validate(practiceSchema, examples)).toBe(true);
    expect(Object.keys(profilesFile.profiles)).toEqual(['A', 'B']);
    expect(examples.examples).toHaveLength(3);
    const ids = notesFile.notes.map((note) => note.id);
    expect(new Set(ids).size).toBe(20);
    expect(notesFile.notes.filter((note) => note.expected.length === 0)).toHaveLength(3);
    const inBand = (text: string) => {
      const count = text.trim().split(/\s+/).length;
      return count >= 150 && count <= 250;
    };
    expect(
      notesFile.notes.filter((note) => note.expected.length > 0 && inBand(note.text)).length,
    ).toBeGreaterThanOrEqual(6);
    expect(
      notesFile.notes.filter((note) => note.expected.length === 0 && inBand(note.text)).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      notesFile.notes.filter((note) => note.privateTokens.length > 0).length,
    ).toBeGreaterThanOrEqual(8);
    const allLabels = notesFile.notes.flatMap((note) => note.expected);
    expect(allLabels).toHaveLength(51);
    expect(allLabels.filter((item) => item.kind === 'decision')).toHaveLength(20);
    const kinds = ['assumption', 'decision', 'constraint', 'open-question'];
    for (const kind of kinds) {
      expect(
        notesFile.notes.flatMap((note) => note.expected).filter((item) => item.kind === kind)
          .length,
      ).toBeGreaterThanOrEqual(3);
    }
    for (const note of notesFile.notes) {
      expect(note.text.trim().split(/\s+/).length).toBeGreaterThanOrEqual(80);
      expect(note.text.trim().split(/\s+/).length).toBeLessThanOrEqual(250);
      expect(note.expected.length).toBeLessThanOrEqual(4);
      const ranges = note.expected.map((item) => {
        expect(note.text).toContain(item.span);
        const start = note.text.indexOf(item.span);
        expect(note.text.lastIndexOf(item.span)).toBe(start);
        return { start, end: start + item.span.length };
      });
      for (let i = 0; i < ranges.length; i++) {
        for (let j = i + 1; j < ranges.length; j++) {
          expect(ranges[i].end <= ranges[j].start || ranges[j].end <= ranges[i].start).toBe(true);
        }
      }
      for (const token of note.privateTokens) expect(note.text).toContain(token);
    }
    expect(changesFile.changes.filter((change) => change.expectedChanged)).toHaveLength(3);
    expect(new Set(changesFile.changes.map((change) => change.noteId)).size).toBe(6);
    const n04 = notesFile.notes.find((note) => note.id === 'n04')!;
    const n04Decision = n04.expected.find((item) => item.kind === 'decision')!;
    const n04Change = changesFile.changes.find((change) => change.noteId === 'n04')!;
    expect(n04Change.editedText).toContain(n04Decision.span);
    for (const change of changesFile.changes) {
      expect(ids).toContain(change.noteId);
      const original = notesFile.notes.find((note) => note.id === change.noteId)!;
      expect(change.editedText).not.toBe(original.text);
      expect(original.expected.some((item) => item.span === change.targetSpan)).toBe(true);
      for (const item of original.expected.filter((item) => item.span !== change.targetSpan)) {
        expect(change.editedText).toContain(item.span);
      }
      if (change.expectedChanged) {
        expect(change.editedText).not.toContain(change.targetSpan);
      }
    }
  });

  it('audits want, wants, wanted and rather intent with explicit exemptions', () => {
    const exemptions: Record<string, string> = {
      'n01:I want to keep the first setup simple while I learn how people browse.': 'Vague aim',
      ['n01:I want the trial to include both first-time visitors ' +
      'and someone who already knows what they are looking for.']: 'Trial design',
      ['n02:Before inviting more helpers I want to walk through account removal ' +
      'and document who needs to change a shared credential.']: 'Rehearsal',
      ['n06:I would rather test a clear offer than build a complicated billing screen ' +
      'before anyone signs up.']: 'Test preference',
      'n20:I like the second direction but want to keep both on the board for now.': 'Brainstorm',
    };
    const intent = /\bwant(?:s|ed)?\b|\bwould\s+rather\b|['’]d\s+rather\b/i;
    for (const phrase of ['want', 'wants', 'wanted', 'would rather', "I'd rather", "don't want"]) {
      expect(intent.test(phrase)).toBe(true);
    }
    const seen = new Set<string>();
    for (const note of notesFile.notes) {
      const sentences = note.text.match(/[^.!?]+[.!?]*/g) ?? [];
      for (const raw of sentences) {
        const sentence = raw.trim();
        if (!intent.test(sentence)) continue;
        const key = `${note.id}:${sentence}`;
        if (key in exemptions) {
          expect(exemptions[key].length).toBeGreaterThan(0);
          expect(note.expected.some((item) => sentence.includes(item.span))).toBe(false);
          seen.add(key);
        } else {
          expect(
            note.expected.some((item) => sentence.includes(item.span) && intent.test(item.span)),
          ).toBe(true);
        }
      }
    }
    expect([...seen].sort()).toEqual(Object.keys(exemptions).sort());
    expect(notesFile.notes.find((note) => note.id === 'n04')?.expected).toContainEqual({
      kind: 'decision',
      span: 'I do not want the person waiting on a spinning page while a separate service is busy',
      topics: ['frontend', 'performance'],
    });
  });
});
