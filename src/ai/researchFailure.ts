export type ResearchFailureCode = 'network' | 'quota' | 'billing' | 'safety' | 'display-invalid' |
  'source-invalid' | 'permission' | 'unknown';

const messages: Record<ResearchFailureCode, string> = {
  network: 'Network error while researching. Please try again.',
  quota: "The demo's cloud budget is used up. Everything on your laptop still works.",
  billing: 'Cloud billing is unavailable right now. Everything on your laptop still works.',
  safety: 'Research was blocked by the provider’s safety checks.',
  'display-invalid': 'Research could not be displayed with its required Search sources and suggestions.',
  'source-invalid': 'Cloud research did not run in the cloud.',
  permission: 'The cloud refused this request. Everything on your laptop still works.',
  unknown: 'Research could not be completed. Check billing, connection and project settings.',
};

export function isResearchFailureCode(code: unknown): code is ResearchFailureCode {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(messages, code);
}
export function researchFailureMessage(code: unknown): string {
  return isResearchFailureCode(code) ? messages[code] : messages.unknown;
}
export function safeResearchErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const preflight = [
    'Firebase or local storage is unavailable.', 'Cloud research is currently disabled.',
    'Approve this question before researching it.', 'Research consent was not granted.',
    'Save your plan before researching.', 'Daily research limit reached. Resets tomorrow.',
    'This question cannot be sent: your plan or privacy settings changed.',
  ];
  return [...Object.values(messages), ...preflight].includes(message) ? message : messages.unknown;
}
