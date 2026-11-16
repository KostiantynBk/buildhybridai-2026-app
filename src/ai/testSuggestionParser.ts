import { vi } from 'vitest';

// Minimal test double for synthetic safe fixtures only. Security cases supply explicit element/attribute mocks.
export function stubSafeSuggestionParser() {
  vi.stubGlobal('DOMParser', class {
    parseFromString() { return { querySelector: () => null, querySelectorAll: () => [] }; }
  });
}
