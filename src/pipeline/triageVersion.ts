export type TriageVersion = 'v1' | 'v2' | 'v2.1';
// Deliberate code-only switch; not controlled by Remote Config.
export const TRIAGE_PROMPT_SET = 'v2.1' as TriageVersion;
export function versionFromPrompt(promptVersion: string): TriageVersion {
  return promptVersion.endsWith('.v2.1') ? 'v2.1' : promptVersion.endsWith('.v2') ? 'v2' : 'v1';
}
export function triagePromptVersions(version: TriageVersion = TRIAGE_PROMPT_SET) {
  return { angles: `angles.${version}`, question: `question.${version}`,
    whynote: version === 'v1' ? 'whynote.v1' : version === 'v2' ? 'whynote.v2' : null } as const;
}
