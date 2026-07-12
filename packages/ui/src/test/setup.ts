import "@testing-library/jest-dom/vitest";
import { expect } from "vitest";
import { toHaveNoViolations } from "jest-axe";

expect.extend(toHaveNoViolations);

// jsdom does not implement matchMedia; RedlineDiff uses it to pick a
// responsive default view mode (Spec 14 FR-10). Provide a minimal,
// deterministic mock (defaults to "matches: false", i.e. narrow/inline)
// so every test file gets a stable starting point regardless of load
// order, and tests that care about a specific viewport can override
// `window.matchMedia` themselves before rendering.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false
  }) as unknown as MediaQueryList;
}
