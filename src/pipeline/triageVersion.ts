export type TriageVersion = 'v1' | 'v2';
// Deliberate code-only switch; not controlled by Remote Config.
export const TRIAGE_PROMPT_SET = 'v2' as TriageVersion;
export function triagePromptVersions(version: TriageVersion = TRIAGE_PROMPT_SET) {
  return { angles: `angles.${version}`, question: `question.${version}`, whynote: `whynote.${version}` } as const;
}
