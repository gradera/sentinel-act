// Spec 02 §10 unit tests: canonicalizeText, computeSourceHash.
import { describe, expect, it } from "vitest";
import { canonicalizeText, computeSourceHash } from "../regulatory-watch.agent.js";
import { loadFixture } from "./fixtures.js";

describe("canonicalizeText", () => {
  const html = loadFixture("detail-page-nav-footer-noise.html");

  it("strips nav/footer/share-widget/timestamp chrome (FR-9)", () => {
    const text = canonicalizeText(html);
    expect(text).not.toMatch(/facebook/i);
    expect(text).not.toMatch(/sitemap/i);
    expect(text).not.toMatch(/viewed \d/i);
    expect(text).not.toMatch(/last updated/i);
    expect(text).not.toMatch(/home \| circulars/i);
    expect(text).not.toMatch(/privacy policy/i);
  });

  it("retains the substantive body text", () => {
    const text = canonicalizeText(html);
    expect(text).toMatch(/reporting timelines for intermediaries/i);
    expect(text).toMatch(/quarterly reports within 15 days/i);
  });

  it("collapses internal whitespace runs to single spaces", () => {
    const noisy = '<html><body><div class="circular-body"><p>Some   text   with     extra   spaces.</p></div></body></html>';
    expect(canonicalizeText(noisy)).toBe("Some text with extra spaces.");
  });

  it("is stable (idempotent) when run twice on its own output", () => {
    const once = canonicalizeText(html);
    const wrapped = `<html><body>${once}</body></html>`;
    const twice = canonicalizeText(wrapped);
    expect(twice).toBe(once);
  });
});

describe("computeSourceHash", () => {
  it("produces identical hashes across two calls on identical canonical text", () => {
    const text = "1. All intermediaries shall submit quarterly reports.";
    expect(computeSourceHash(text)).toBe(computeSourceHash(text));
  });

  it("produces a different hash for a single-character change", () => {
    const a = "1. All intermediaries shall submit quarterly reports.";
    const b = "1. All intermediaries shall submit quarterly report.";
    expect(computeSourceHash(a)).not.toBe(computeSourceHash(b));
  });

  it("is lowercase hex sha256 (64 chars), matching Circular.source_hash's documented type", () => {
    expect(computeSourceHash("some text")).toMatch(/^[0-9a-f]{64}$/);
  });
});
