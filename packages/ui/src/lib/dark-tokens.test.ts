import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Spec 14 FR-26 / DoD: ".dark block extended for all nine
 * risk/confidence/urgency tokens; verified manually ... no token
 * silently falls back to its light-mode value." A manual toggle-and-eyeball
 * pass isn't something this environment can perform (no real browser
 * reachable from the test/build sandbox) — this test is the automated
 * proxy: it parses the actual globals.css source (not a hardcoded copy,
 * unlike contrast.test.ts's fixture values) and asserts every one of the
 * nine tokens is redefined inside `.dark` with a value different from
 * `:root`, so a future edit that forgets to update the dark variant, or
 * silently reintroduces a fallback, fails CI instead of only showing up
 * as a visual regression someone has to notice by eye.
 */

const TOKENS = [
  "--risk-a",
  "--risk-b",
  "--risk-c",
  "--risk-escalate",
  "--confidence-high",
  "--confidence-medium",
  "--confidence-low",
  "--urgency-now",
  "--urgency-in-motion",
  "--urgency-archive"
];

const cssPath = path.resolve(fileURLToPath(import.meta.url), "../../styles/globals.css");
const css = readFileSync(cssPath, "utf-8");

function extractBlock(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`Could not find "${selector} {" block in globals.css`);
  const end = css.indexOf("}", start);
  return css.slice(start, end);
}

function extractValue(block: string, token: string): string | null {
  const re = new RegExp(`${token.replace(/[-]/g, "\\-")}:\\s*([^;]+);`);
  const match = block.match(re);
  return match ? match[1].trim() : null;
}

const rootBlock = extractBlock(":root");
const darkBlock = extractBlock(".dark");

describe("globals.css .dark block (Spec 14 FR-26) — structural drift guard", () => {
  it.each(TOKENS)("%s is defined in :root", (token) => {
    expect(extractValue(rootBlock, token)).not.toBeNull();
  });

  it.each(TOKENS)("%s is redefined inside .dark (does not fall back to :root)", (token) => {
    const darkValue = extractValue(darkBlock, token);
    expect(darkValue, `--${token} is missing from the .dark block entirely`).not.toBeNull();
  });

  it.each(TOKENS)("%s has a different value in .dark than in :root", (token) => {
    const rootValue = extractValue(rootBlock, token);
    const darkValue = extractValue(darkBlock, token);
    expect(
      darkValue,
      `${token} in .dark ("${darkValue}") is identical to :root ("${rootValue}") — likely an accidental no-op override`
    ).not.toBe(rootValue);
  });
});
