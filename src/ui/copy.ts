export const copy = {
  tagline: 'An independent second opinion on your plan.',
  welcomePromise: 'ThoughtPartner gives your plan an independent second opinion while you write: what is worth ' +
    'checking, who has already built something similar, what is different about yours, and what you could combine ' +
    'it with, backed by web sources. You decide what leaves your laptop, and it tells you when an answer no longer ' +
    'fits your plan.',
  welcomeLocal: 'Your notebook stays in this browser. Nothing from your plan is sent until you approve it.',
  welcomeCloud: 'Your notebook stays in this browser; cloud mode sends plan inputs to Google for processing.',
  firebaseContact: 'To verify the app and load its settings, Firebase contacts Google even before any research; ' +
    'this carries no plan text.',
  definite: 'Your plan changed since this was checked.',
  uncertain: "We couldn't confirm this still matches your plan.",
  draftQuestion: 'Drafting your question…',
  draftDescription: 'Drafting a description…',
  searching: 'Searching the web…',
  extractionFailed: 'We could not finish reading this paragraph.',
  readingLocal: 'Reading your paragraph on this device…',
  readingCloud: 'Reading your paragraph in the cloud…',
  waiting: 'Waiting for you to finish writing…',
  waitingRead: 'Waiting to read your paragraph…',
  questionHeading: 'Why this is here',
  profileVariant: 'From your profile',
  requestedVariant: 'You asked for this check',
  approvedNotSent: 'Approved, not sent.',
  checkingBeforeResearch: 'Checking before sending…',
  requestSent: 'Research request sent; awaiting completion.',
  researchCompleted: 'Research completed.',
  modeChanged: 'Mode changed, draft again.',
  draftUnavailable: 'Draft unavailable. Draft again.',
  noSources: 'This answer used no web sources.',
  resultsNotSaved: 'Research completed. Results are not saved. Research again to see them.',
} as const;

// <!-- Navigator: confirm on Chrome 157 -->
export const chromeSetup = [
  'Enable chrome://flags/#gemma4-for-built-in-ai.',
  'Restart Chrome.',
  'Enable prompt_api_gemma4 in chrome://on-device-internals. If needed, enable debug pages at chrome://chrome-urls.',
] as const;
// <!-- /Navigator -->

export function displayMessage(message: string): string {
  if (message === 'Your plan changed. Draft again.') return `${copy.definite} Draft again.`;
  if (message === 'Your plan changed. Check again.') return `${copy.definite} Check again.`;
  return message;
}
