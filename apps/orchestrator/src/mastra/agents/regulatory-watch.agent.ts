// Regulatory Watch and Ingestion Agent (Spec 02).
// Polls SEBI's circular listings on a cron schedule, fetches new pages
// with an automated browser (SEBI publishes HTML, not a public API),
// detects anything not yet represented in the graph, and hands cleaned,
// chunked text to the Orchestrator. Triggers the Orchestrator rather
// than being fanned out to by it — see architecture walkthrough §1.
//
// This unit is deterministic and non-LLM: browser automation, text
// processing, hashing, and regex/heuristic extraction only. It never
// writes to the graph itself (Spec 01 owns persistence) — it only
// *proposes* Circular/Clause candidates on a RegulatoryWatchTriggerEvent
// for the Orchestrator to commit.
//
// --- What's real vs. stubbed in this file (read before wiring anything
//     downstream into this unit) ---
//
// REAL, fully unit-testable, no unresolved external API dependency:
//   canonicalizeText, computeSourceHash, chunkIntoClauses,
//   extractAmendmentContext, detectChangeType (once given a working
//   findCircularBySourceHash/findCircularsByTitleFuzzy), the FR-2
//   overlapping-poll guard, raiseOpsAlert's alerting/logging logic, and
//   the whole runPollCycle orchestration (retry/backoff, partial-failure
//   isolation, structured logging).
//
// STUB, deliberately, pending confirmed Mastra APIs / Spec 08:
//   1. `defaultBrowserFetch` — MastraBrowser (@mastra/core/browser) is an
//      ABSTRACT class built around an interactive multi-tool browsing
//      session (17 ref-based tools, or AI-powered act/extract/observe
//      tools per provider), not a one-shot "fetch(url) -> html" call.
//      Verified by reading node_modules/@mastra/core/dist/browser/browser.d.ts
//      (v1.50.1) directly — there is no ready-made primitive to wire a
//      simple "navigate + wait for selector + read HTML" call onto
//      without first choosing and lifecycle-managing a concrete provider
//      (AgentBrowser, StagehandBrowser, ...). `browserFetch` is an
//      injectable dependency (see WatchDependencies) specifically so this
//      module's real logic is fully testable today without that being
//      resolved; the default implementation throws a descriptive error
//      rather than silently returning fake data.
//   2. `defaultInvokeOrchestrator` (emitTrigger's Orchestrator call,
//      §5.4 Option A) — `orchestrator.workflow.ts` currently exports
//      `orchestratorWorkflowStub`, a plain data object with no
//      `createRun()/start()` methods (Spec 08, Workflow Orchestrator, has
//      not landed — this unit is step 2 of an 11-step build order, Spec 08
//      is step 8). The default implementation defensively checks for a
//      real workflow entry point at call time and, finding none yet, logs
//      the event (FR-25 still satisfied — eventId is logged before this
//      is even attempted) and returns normally rather than throwing. This
//      is a deliberate, documented stub path, not a bug: throwing here
//      would incorrectly turn every "new"/"amendment" poll result into a
//      PollError under the current, expected, Spec-08-not-yet-landed
//      condition (see FR-26's discussion in the doc comment on
//      defaultInvokeOrchestrator below).
//   3. `regulatoryWatchSchedule` — the `cron` + `handler` shape spec §5.1
//      documents is exported below, but it is not yet registered against
//      a live Mastra `Schedules`/`Mastra` instance: `apps/orchestrator/src/
//      mastra/index.ts` is itself still a stub (`export * from ...`, no
//      `new Mastra({ agents, workflows })`). Wiring this cron config into
//      a real scheduler is blocked on that landing.

import { randomUUID, createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import type { Circular } from "@sentinel-act/graph-schema";
import {
  findCircularBySourceHash as graphDbFindCircularBySourceHash,
  findCircularsByTitleFuzzy as graphDbFindCircularsByTitleFuzzy,
  titleSimilarity
} from "@sentinel-act/graph-db";
import type {
  ListingEntry,
  FetchedCircularPage,
  CircularCandidate,
  ClauseCandidate,
  ChangeType,
  AmendmentContext,
  PollRun,
  PollError,
  RegulatoryWatchTriggerEvent,
  WatchOpsAlert
} from "./regulatory-watch.types.js";

// ============================================================================
// §5.2 — listing/detail page config (§13: exact SEBI selectors are
// unconfirmed against live markup — this is the single highest-risk
// unconfirmed assumption flagged by the spec; update once someone has
// visited the real SEBI circulars section and recorded actual selectors).
// ============================================================================

export interface ListingConfig {
  listingUrls: string[];
  rowSelector: string;
  titleSelector: string;
  dateSelector: string;
  categorySelector: string;
  linkAttr: string;
}

export interface DetailConfig {
  bodySelector: string;
  minBodyChars: number;
}

export const LISTING_CONFIG: ListingConfig = {
  // SEBI publishes separate listing pages per department/category.
  // Configurable list; exact URLs are a placeholder pending confirmation.
  listingUrls: (process.env.SEBI_LISTING_URLS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean),
  rowSelector: "table.circular-listing tbody tr", // one row per circular
  titleSelector: "td.title a",
  dateSelector: "td.date",
  categorySelector: "td.category",
  linkAttr: "href"
};

export const DETAIL_CONFIG: DetailConfig = {
  bodySelector: "div.circular-body, div#pageContent",
  minBodyChars: 200 // structural-validity floor, see FR-8/FR-21
};

// ============================================================================
// §5.1 — Mastra Schedule (cron trigger). See file-header note #3: not yet
// registered against a live Mastra instance (blocked on
// apps/orchestrator/src/mastra/index.ts and Spec 08).
// ============================================================================

export const regulatoryWatchSchedule = {
  cron: process.env.REGULATORY_WATCH_POLL_CRON ?? "0 */4 * * *", // every 4h — PLACEHOLDER, see §13
  handler: runPollCycle, // see below
  timezone: "Asia/Kolkata"
};

// ============================================================================
// §5.2 — Browser primitive contract.
// ============================================================================

export interface BrowserFetchConfig {
  url: string;
  waitForSelector: string;
  timeoutMs: number;
}

export type BrowserFetchFn = (config: BrowserFetchConfig) => Promise<{ html: string; finalUrl: string }>;

/** See file-header note #1. Injectable default — throws rather than
 *  fabricating data. Every real caller (fetchListingEntries,
 *  fetchCircularDetail) takes `browserFetch` via WatchDependencies, so a
 *  working implementation (or, in tests, a fixture-backed mock) can be
 *  substituted without touching any other logic in this module. */
async function defaultBrowserFetch(config: BrowserFetchConfig): Promise<{ html: string; finalUrl: string }> {
  throw new Error(
    `browserFetch is not yet wired to Mastra's Browser primitive (MastraBrowser is an abstract, ` +
      `tool-oriented CDP browser session, not a one-shot fetch — see the doc comment at the top of ` +
      `regulatory-watch.agent.ts). Requested url: ${config.url}. Inject a working browserFetch via ` +
      `WatchDependencies until this is resolved.`
  );
}

// ============================================================================
// Dependency injection seam. Every exported function below takes an
// optional trailing `deps: Partial<WatchDependencies>` param (same
// pattern packages/graph-db's driver.ts uses for `verifyConnectivity`),
// so production callers get the documented spec §5.3 signature by
// default while tests can substitute fixture-backed/mock implementations
// for every external effect (browser fetch, graph reads, Orchestrator
// invocation, Slack webhook, wall-clock sleeps).
// ============================================================================

export interface WatchDependencies {
  browserFetch: BrowserFetchFn;
  findCircularBySourceHash: (hash: string) => Promise<Circular | null>;
  findCircularsByTitleFuzzy: (title: string, category: string) => Promise<Circular[]>;
  invokeOrchestrator: (event: RegulatoryWatchTriggerEvent) => Promise<void>;
  postOpsAlertWebhook: (alert: WatchOpsAlert) => Promise<void>;
  listingUrls: string[];
  listingConfig: ListingConfig;
  detailConfig: DetailConfig;
  browserFetchTimeoutMs: number;
  maxRetries: number;
  retryBackoffBaseMs: number;
  sleep: (ms: number) => Promise<void>;
  detailFetchConcurrency: number;
  interRequestDelayMs: number;
  /** Per-listing-URL row count from the last successful poll — the state
   *  FR-5's "previously >= 1 row" comparison needs. Persists across
   *  `runPollCycle` calls by default (module-level singleton); tests
   *  inject a fresh Map per test to avoid cross-test bleed. */
  rowCountHistory: Map<string, number>;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BACKOFF_BASE_MS = 2000;
const DEFAULT_DETAIL_FETCH_CONCURRENCY = 3;
const DEFAULT_INTER_REQUEST_DELAY_MS = 500;

const defaultRowCountHistory = new Map<string, number>();

function buildDefaultDependencies(): WatchDependencies {
  return {
    browserFetch: defaultBrowserFetch,
    findCircularBySourceHash: (hash) => graphDbFindCircularBySourceHash(hash),
    findCircularsByTitleFuzzy: (title, category) => graphDbFindCircularsByTitleFuzzy(title, category),
    invokeOrchestrator: defaultInvokeOrchestrator,
    postOpsAlertWebhook: defaultPostOpsAlertWebhook,
    listingUrls: LISTING_CONFIG.listingUrls,
    listingConfig: LISTING_CONFIG,
    detailConfig: DETAIL_CONFIG,
    browserFetchTimeoutMs: Number(process.env.BROWSER_FETCH_TIMEOUT_MS ?? 15000),
    maxRetries: DEFAULT_MAX_RETRIES,
    retryBackoffBaseMs: DEFAULT_RETRY_BACKOFF_BASE_MS,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    detailFetchConcurrency: DEFAULT_DETAIL_FETCH_CONCURRENCY,
    interRequestDelayMs: DEFAULT_INTER_REQUEST_DELAY_MS,
    rowCountHistory: defaultRowCountHistory
  };
}

function mergeDeps(overrides: Partial<WatchDependencies>): WatchDependencies {
  return { ...buildDefaultDependencies(), ...overrides };
}

// ============================================================================
// Structured logging (FR-27, NFR "Observability"). Mirrors
// packages/graph-db/src/logger.ts's shape/conventions (JSON line to
// stdout, never throws) — a separate, equivalent implementation rather
// than a cross-package import, since graph-db's logOperation is scoped to
// its own repository operations (`label`, `proposalId`) and this unit's
// stage-transition vocabulary (listing fetched, change decided, trigger
// emitted, ...) doesn't map cleanly onto that shape.
// ============================================================================

function logStage(stage: string, detail: Record<string, unknown> = {}): void {
  try {
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", unit: "regulatory-watch", stage, ...detail }));
  } catch {
    // Logging must never break the poll cycle.
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

// ============================================================================
// FR-8: structural-failure signal, distinguished from a generic fetch
// failure so callers can raise `selector_mismatch` specifically.
// ============================================================================

export class StructuralMismatchError extends Error {
  constructor(
    message: string,
    public readonly detailUrl: string
  ) {
    super(message);
    this.name = "StructuralMismatchError";
  }
}

// ============================================================================
// Retry helper — NFR "Performance": up to 2 retries, exponential backoff
// (base 2s). `deps.sleep` is overridden to a no-op in tests so retry
// tests don't actually wait multiple seconds.
// ============================================================================

async function withRetry<T>(work: () => Promise<T>, deps: WatchDependencies): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= deps.maxRetries; attempt++) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      if (attempt < deps.maxRetries) {
        await deps.sleep(deps.retryBackoffBaseMs * 2 ** attempt);
      }
    }
  }
  throw lastError;
}

// ============================================================================
// §5.3 — fetchListingEntries (FR-4/FR-6). Structural validation (FR-5) is
// deliberately NOT done here — it needs poll-run-level history
// (rowCountHistory) and alerting, which belongs in runPollCycle's
// per-URL loop, keeping this function a pure fetch+parse primitive.
// ============================================================================

export async function fetchListingEntries(listingUrl: string, depsOverride: Partial<WatchDependencies> = {}): Promise<ListingEntry[]> {
  const deps = mergeDeps(depsOverride);
  const { html } = await withRetry(
    () =>
      deps.browserFetch({
        url: listingUrl,
        waitForSelector: deps.listingConfig.rowSelector,
        timeoutMs: deps.browserFetchTimeoutMs
      }),
    deps
  );

  const dom = new JSDOM(html);
  const rows = Array.from(dom.window.document.querySelectorAll(deps.listingConfig.rowSelector));

  const entries: ListingEntry[] = rows.map((row) => {
    const titleEl = row.querySelector(deps.listingConfig.titleSelector);
    const dateEl = row.querySelector(deps.listingConfig.dateSelector);
    const categoryEl = row.querySelector(deps.listingConfig.categorySelector);
    const href = titleEl?.getAttribute(deps.listingConfig.linkAttr) ?? "";

    let detailUrl = href;
    try {
      detailUrl = new URL(href, listingUrl).toString();
    } catch {
      // Leave as-is (relative/unparseable) rather than dropping the row —
      // better to surface a bad detailUrl downstream (as a detail_fetch
      // PollError) than to silently skip a circular.
    }

    return {
      detailUrl,
      listingTitle: (titleEl?.textContent ?? "").trim(),
      listingDateText: (dateEl?.textContent ?? "").trim(),
      listingCategoryHint: (categoryEl?.textContent ?? "").trim()
    };
  });

  logStage("listing_fetched", { listingUrl, entryCount: entries.length });
  return entries;
}

// ============================================================================
// canonicalizeText (FR-9, FR-22) — pure, self-contained. Strips known
// chrome (nav/footer/breadcrumb/share-widget/timestamp/script/style),
// scopes to DETAIL_CONFIG.bodySelector when present (falling back to
// document.body), and normalizes whitespace line-by-line so
// paragraph-numbering boundaries survive for chunkIntoClauses (FR-20)
// while cosmetic whitespace differences don't change the hash (FR-10).
// ============================================================================

const CHROME_SELECTORS = [
  "nav",
  "footer",
  "header",
  "script",
  "style",
  "noscript",
  ".breadcrumb",
  ".breadcrumbs",
  ".share-widget",
  ".social-share",
  ".last-modified",
  ".view-count",
  ".print-button",
  ".download-pdf"
];

const BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "BR",
  "LI",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "TR",
  "TABLE",
  "SECTION",
  "ARTICLE",
  "UL",
  "OL",
  "BLOCKQUOTE"
]);

/** Walks the DOM subtree, inserting a newline marker at block-element
 *  boundaries (approximating a browser's "innerText" behavior) so
 *  paragraph structure in the source markup survives as line breaks in
 *  the extracted plain text. */
function extractBlockText(root: Element): string {
  const parts: string[] = [];

  function walk(node: ChildNode): void {
    if (node.nodeType === node.TEXT_NODE) {
      parts.push(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== node.ELEMENT_NODE) return;
    const el = node as Element;
    if (el.tagName === "SCRIPT" || el.tagName === "STYLE") return;
    const isBlock = BLOCK_TAGS.has(el.tagName);
    if (isBlock) parts.push("\n");
    for (const child of Array.from(el.childNodes)) walk(child);
    if (isBlock) parts.push("\n");
  }

  walk(root);
  return parts.join("");
}

/** Collapses horizontal whitespace within each line, drops now-blank
 *  lines, and rejoins with a single "\n" between kept lines — stable
 *  (idempotent) whether run once or twice, and preserves the line
 *  boundaries chunkIntoClauses's numbering regexes match against. */
function normalizeWhitespace(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}

export function canonicalizeText(rawHtml: string): string {
  const dom = new JSDOM(rawHtml);
  const { document } = dom.window;

  for (const selector of CHROME_SELECTORS) {
    document.querySelectorAll(selector).forEach((el) => el.remove());
  }

  const scopedRoot = document.querySelector(DETAIL_CONFIG.bodySelector) ?? document.body ?? document.documentElement;
  const rawText = extractBlockText(scopedRoot);
  return normalizeWhitespace(rawText);
}

// ============================================================================
// computeSourceHash (FR-10).
// ============================================================================

export function computeSourceHash(canonicalText: string): string {
  return createHash("sha256").update(canonicalText, "utf8").digest("hex");
}

// ============================================================================
// §5.3 — fetchCircularDetail (FR-7/FR-8/FR-11).
// ============================================================================

export async function fetchCircularDetail(entry: ListingEntry, depsOverride: Partial<WatchDependencies> = {}): Promise<FetchedCircularPage> {
  const deps = mergeDeps(depsOverride);
  const { html } = await withRetry(
    () =>
      deps.browserFetch({
        url: entry.detailUrl,
        waitForSelector: deps.detailConfig.bodySelector,
        timeoutMs: deps.browserFetchTimeoutMs
      }),
    deps
  );

  const canonicalText = canonicalizeText(html);
  if (canonicalText.length < deps.detailConfig.minBodyChars) {
    throw new StructuralMismatchError(
      `Detail page body text (${canonicalText.length} chars) is below minBodyChars ` +
        `(${deps.detailConfig.minBodyChars}) — DETAIL_CONFIG.bodySelector likely no longer matches SEBI's markup.`,
      entry.detailUrl
    );
  }

  const sourceHash = computeSourceHash(canonicalText);
  const page: FetchedCircularPage = {
    detailUrl: entry.detailUrl,
    rawHtml: html, // FR-11: audit/debug only, never persisted onto Circular
    canonicalText,
    sourceHash,
    fetchedAt: nowIso()
  };

  logStage("detail_fetched", { detailUrl: entry.detailUrl, canonicalTextLength: canonicalText.length, sourceHash });
  return page;
}

// ============================================================================
// §5.3 — detectChangeType (FR-12/FR-13/FR-14).
// ============================================================================

const FULL_DOCUMENT_SIMILARITY_THRESHOLD = 0.85; // §13 recommended default

export async function detectChangeType(
  page: FetchedCircularPage,
  entry: ListingEntry,
  depsOverride: Partial<WatchDependencies> = {}
): Promise<{ changeType: ChangeType; existing: Circular | null }> {
  const deps = mergeDeps(depsOverride);

  // FR-12: exact source_hash match short-circuits everything else.
  const exactMatch = await deps.findCircularBySourceHash(page.sourceHash);
  if (exactMatch) {
    return { changeType: "unchanged", existing: exactMatch };
  }

  // FR-13: full-document replacement — fuzzy title match in the same
  // category, above the 0.85 threshold, against a currently-live circular.
  const category = entry.listingCategoryHint || "uncategorized";
  const candidates = await deps.findCircularsByTitleFuzzy(entry.listingTitle, category);
  const best = candidates[0];
  if (best) {
    const score = titleSimilarity(entry.listingTitle, best.title);
    if (score >= FULL_DOCUMENT_SIMILARITY_THRESHOLD) {
      return { changeType: "amendment", existing: best };
    }
  }

  // FR-14.
  return { changeType: "new", existing: null };
}

// ============================================================================
// §5.3 — chunkIntoClauses (FR-20/FR-21/FR-22/FR-23).
//
// Spec §5.3 documents this as a 2-arg function (canonicalText,
// circularId). FR-23 additionally requires valid_from/valid_to to be
// copied from the parent CircularCandidate's date_effective — information
// the 2-arg signature has no way to carry. Rather than silently guessing
// a date inside this function, a third, OPTIONAL `dateEffective` param is
// added (defaulting to today, matching the 2-arg call shape spec §5.3
// documents for any caller that doesn't care about FR-23's exact value);
// the real production call site (runPollCycle) always supplies it
// explicitly.
// ============================================================================

interface NumberingMatch {
  paraRef: string;
  remainder: string;
}

// Exported (additively) so Spec 06's Change and Delta marker-split (FR-7)
// reuses this exact numbering-pattern family instead of forking a second
// copy — see docs/specs/06-change-and-delta-agent.md §11 task 5.
export function matchNumberingToken(line: string): NumberingMatch | null {
  // Most specific first: "46(a)" nested paragraph+sub-clause reference.
  const nested = /^(\d+\([a-zA-Z]\))\.?\s+(.*)$/.exec(line);
  if (nested) return { paraRef: nested[1], remainder: nested[2] };

  // Plain numeric / dotted-nested: "1.", "46.", "3.2".
  const numeric = /^(\d+(?:\.\d+)*)\.?\s+(.*)$/.exec(line);
  if (numeric) return { paraRef: numeric[1], remainder: numeric[2] };

  // Lettered sub-clause: "a) ...".
  const lettered = /^([a-zA-Z])\)\s+(.*)$/.exec(line);
  if (lettered) return { paraRef: lettered[1].toLowerCase(), remainder: lettered[2] };

  // Roman numeral: "i. ...", restricted to valid roman-numeral letters to
  // avoid false-positives on ordinary word-initial capital letters.
  const roman = /^([ivxlcdmIVXLCDM]+)\.\s+(.*)$/.exec(line);
  if (roman) return { paraRef: roman[1].toLowerCase(), remainder: roman[2] };

  return null;
}

function makeClauseCandidate(paraRef: string, text: string, circularId: string, dateEffective: string): ClauseCandidate {
  return {
    clause_id: randomUUID(),
    circular_id: circularId,
    para_ref: paraRef,
    text: text.trim(),
    valid_from: dateEffective,
    valid_to: null, // FR-23: null unless the parent circular is itself superseded
    recorded_at: null,
    embedding_ref: ""
  };
}

export function chunkIntoClauses(canonicalText: string, circularId: string, dateEffective?: string): ClauseCandidate[] {
  const validFrom = dateEffective ?? nowIso().slice(0, 10);
  const lines = canonicalText.split("\n");

  const preambleLines: string[] = [];
  const clauseBlocks: Array<{ paraRef: string; textLines: string[] }> = [];
  let current: { paraRef: string; textLines: string[] } | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const match = matchNumberingToken(line);
    if (match) {
      if (current) clauseBlocks.push(current);
      current = { paraRef: match.paraRef, textLines: match.remainder ? [match.remainder] : [] };
    } else if (current) {
      current.textLines.push(line);
    } else {
      preambleLines.push(line);
    }
  }
  if (current) clauseBlocks.push(current);

  const result: ClauseCandidate[] = [];
  // FR-21: preamble text (if any) is captured, never discarded.
  if (preambleLines.length > 0) {
    result.push(makeClauseCandidate("preamble", preambleLines.join(" "), circularId, validFrom));
  }
  for (const block of clauseBlocks) {
    result.push(makeClauseCandidate(block.paraRef, block.textLines.join(" "), circularId, validFrom));
  }
  return result;
}

// ============================================================================
// §5.3 — extractAmendmentContext (FR-16/FR-17/FR-18/FR-19).
// ============================================================================

// FR-16's illustrative regex set — used to DETECT that amendment-signaling
// language is present at all.
const AMEND_TO_PARA_PATTERN = /amend(?:ment|s|ed)?\s+(?:to\s+)?(?:paragraph|para|clause)\s+(\d+[\w.]*)/i;
const MASTER_CIRCULAR_DATED_PATTERN = /master circular[\s\S]*?dated/i;
const PARTIAL_MODIFICATION_PATTERN = /in partial modification of/i;
const READ_WITH_PATTERN = /read with/i;
const STANDS_SUBSTITUTED_PATTERN = /stands? (?:substituted|amended|modified)/i;

// Extension beyond FR-16's literal illustrative pattern: real SEBI
// amendment phrasing (the flagship CUSPA/Paragraph 46 case, spec §9
// Acceptance Criterion 3) reads "Paragraph 46 ... is amended", i.e.
// subject-first, not "amendment to paragraph 46" (verb-first, which is
// all AMEND_TO_PARA_PATTERN above catches). Without this, Acceptance
// Criterion 3's exact scenario would not extract amendedParaRefs: ["46"].
const SUBJECT_FIRST_AMEND_PATTERN =
  /(?:paragraph|para|clause)\s+(\d+[\w.]*)\s+of\s+[\s\S]*?\bis\s+(?:hereby\s+)?(?:amended|substituted|modified)/gi;

const AMEND_TO_PARA_PATTERN_GLOBAL = new RegExp(AMEND_TO_PARA_PATTERN.source, "gi");

function extractAllParaRefs(text: string): string[] {
  const refs = new Set<string>();
  for (const pattern of [AMEND_TO_PARA_PATTERN_GLOBAL, SUBJECT_FIRST_AMEND_PATTERN]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      refs.add(match[1]);
      if (match[0].length === 0) pattern.lastIndex += 1; // guard against zero-width infinite loops
    }
  }
  return Array.from(refs);
}

/** Extracts a "referenced circular" title phrase (e.g. "Master Circular
 *  for Stock Brokers") to fuzzy-match against candidates, stopping before
 *  a trailing "dated ..." clause when present so the compared phrase is
 *  the circular's own descriptive title, not the title-plus-date string. */
function extractReferencedTitlePhrase(text: string): string | null {
  // The negative lookahead `(?!master circular)` inside the repetition
  // stops the lazy match from crossing over a SECOND "master circular"
  // occurrence (real amendment text often says "...in partial
  // modification of the Master Circular for Stock Brokers, Paragraph 46
  // of the Master Circular for Stock Brokers dated ... is amended" — two
  // occurrences before the one "dated" clause). Without this guard, a
  // plain lazy `[\s\S]*?` would span across both occurrences and produce
  // a garbled, low-similarity phrase instead of the clean title closest
  // to "dated".
  const withDate = /master circular(?:(?!master circular)[\s\S])*?(?=\s+dated\b)/i.exec(text);
  if (withDate) return withDate[0].trim();
  const fallback = /master circular(?:(?!master circular)[^.\n])*/i.exec(text);
  return fallback ? fallback[0].trim() : null;
}

const AMENDMENT_TARGET_SIMILARITY_THRESHOLD = 0.7; // §13 recommended default

export function extractAmendmentContext(canonicalText: string, candidates: Circular[]): AmendmentContext | null {
  const hasAmendmentLanguage =
    AMEND_TO_PARA_PATTERN.test(canonicalText) ||
    MASTER_CIRCULAR_DATED_PATTERN.test(canonicalText) ||
    PARTIAL_MODIFICATION_PATTERN.test(canonicalText) ||
    READ_WITH_PATTERN.test(canonicalText) ||
    STANDS_SUBSTITUTED_PATTERN.test(canonicalText) ||
    SUBJECT_FIRST_AMEND_PATTERN.test(canonicalText);
  // Reset lastIndex on the stateful global pattern used above in a boolean
  // `.test()` context, so a later `.exec()` loop (extractAllParaRefs)
  // starts from the beginning rather than wherever `.test()` left it.
  SUBJECT_FIRST_AMEND_PATTERN.lastIndex = 0;

  if (!hasAmendmentLanguage) return null;

  const amendedParaRefs = extractAllParaRefs(canonicalText);
  const referencedPhrase = extractReferencedTitlePhrase(canonicalText);

  let targetCircularId: string | null = null;
  let targetMatchedOnTitle: string | null = null;
  let bestSimilarity = 0;

  if (referencedPhrase) {
    for (const candidate of candidates) {
      const score = titleSimilarity(referencedPhrase, candidate.title);
      if (score > bestSimilarity) {
        bestSimilarity = score;
        if (score >= AMENDMENT_TARGET_SIMILARITY_THRESHOLD) {
          targetCircularId = candidate.circular_id;
          targetMatchedOnTitle = candidate.title;
        }
      }
    }
  }

  // §13 recommended default confidence heuristic: 0.5 base + 0.3 if a
  // target title match clears 0.7 similarity + 0.2 if a para-ref-shaped
  // token is present.
  let confidence = 0.5;
  if (bestSimilarity >= AMENDMENT_TARGET_SIMILARITY_THRESHOLD) confidence += 0.3;
  if (amendedParaRefs.length > 0) confidence += 0.2;
  confidence = Math.min(confidence, 1);

  return { targetCircularId, targetMatchedOnTitle, amendedParaRefs, confidence };
}

// ============================================================================
// §5.4 — emitTrigger (FR-24/FR-25/FR-26).
// ============================================================================

/** See file-header note #2. Dynamic import (not a static top-level
 *  import) is deliberate: orchestrator.workflow.ts imports
 *  `regulatoryWatchAgent` from THIS file (`trigger:
 *  regulatoryWatchAgent.name`), so a static top-level import of
 *  orchestrator.workflow.ts here would create a circular ESM import that
 *  fails at module-evaluation time (the `regulatoryWatchAgent` binding
 *  would still be in its temporal dead zone when orchestrator.workflow.ts's
 *  top-level code runs, since it would still be waiting on this file's own
 *  first import to resolve). A dynamic `import()` resolves at call time,
 *  well after both modules have finished initializing, which is the
 *  standard fix for this exact shape of circular reference. */
async function defaultInvokeOrchestrator(event: RegulatoryWatchTriggerEvent): Promise<void> {
  const workflowModule = (await import("../workflows/orchestrator.workflow.js")) as {
    orchestratorWorkflowStub: {
      createRun?: () => { start: (input: { triggerData: RegulatoryWatchTriggerEvent }) => Promise<unknown> };
    };
  };
  const workflow = workflowModule.orchestratorWorkflowStub;

  if (typeof workflow.createRun === "function") {
    // Spec §5.4 Option A, once Spec 08 replaces orchestratorWorkflowStub
    // with a real Mastra workflow.
    await workflow.createRun().start({ triggerData: event });
    return;
  }

  // Current reality: orchestratorWorkflowStub (apps/orchestrator/src/
  // mastra/workflows/orchestrator.workflow.ts) is a plain data object with
  // no createRun/start method — Spec 08 has not landed yet. Treating this
  // as a hard failure (throwing) would incorrectly generate a
  // PollError{stage: "trigger_emit"} for every single "new"/"amendment"
  // circular under the current, expected state of the codebase, which
  // would misrepresent what actually happened (a documented, deliberate
  // stub path, not a delivery failure). Once Spec 08 lands, this branch
  // simply stops being reached — replace it there, not by changing this
  // function's signature or FR-25/FR-26's error semantics.
  logStage("trigger_emit_stubbed", {
    eventId: event.eventId,
    pollRunId: event.pollRunId,
    circularId: event.circular.circular_id,
    changeType: event.changeType,
    reason: "orchestratorWorkflowStub has no createRun/start method yet (Spec 08 not landed)"
  });
}

export async function emitTrigger(event: RegulatoryWatchTriggerEvent, depsOverride: Partial<WatchDependencies> = {}): Promise<void> {
  const deps = mergeDeps(depsOverride);
  // FR-25: eventId MUST be logged before delivery is attempted, so a
  // crash between "decided to trigger" and "trigger delivered" is
  // auditable and replayable.
  logStage("trigger_decided", {
    eventId: event.eventId,
    pollRunId: event.pollRunId,
    circularId: event.circular.circular_id,
    changeType: event.changeType
  });
  await deps.invokeOrchestrator(event);
  logStage("trigger_delivered", { eventId: event.eventId, pollRunId: event.pollRunId, circularId: event.circular.circular_id });
}

// ============================================================================
// §5.5 — raiseOpsAlert (FR-28).
// ============================================================================

async function defaultPostOpsAlertWebhook(alert: WatchOpsAlert): Promise<void> {
  const webhookUrl = process.env.REGULATORY_WATCH_OPS_ALERT_WEBHOOK_URL;
  if (!webhookUrl) {
    // Not yet added to the canonical env var table
    // (docs/specs/15-ci-cd-environment-setup.md §4.1 /
    // apps/orchestrator/.env.example) — deliberately not edited here,
    // since that file has unrelated pending changes outside this unit's
    // scope. Add REGULATORY_WATCH_OPS_ALERT_WEBHOOK_URL there when Spec 11
    // (Slack Channels and Signals) wires up real ops-alert delivery.
    logStage("ops_alert_webhook_unconfigured", { alertId: alert.alertId, kind: alert.kind });
    return;
  }

  const payload = {
    text: `:rotating_light: Regulatory Watch alert — ${alert.kind}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `*kind:* ${alert.kind}\n*severity:* ${alert.severity}\n*detailUrl:* ${alert.detailUrl ?? "n/a"}\n` +
            `*pollRunId:* ${alert.pollRunId}\n*message:* ${alert.message}`
        }
      }
    ]
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`Ops alert webhook responded with HTTP ${response.status}`);
  }
}

export async function raiseOpsAlert(alert: WatchOpsAlert, depsOverride: Partial<WatchDependencies> = {}): Promise<void> {
  const deps = mergeDeps(depsOverride);
  logStage("ops_alert", {
    alertId: alert.alertId,
    kind: alert.kind,
    severity: alert.severity,
    pollRunId: alert.pollRunId,
    detailUrl: alert.detailUrl,
    message: alert.message
  });
  try {
    await deps.postOpsAlertWebhook(alert);
  } catch (error) {
    // FR-28: never throw out of here — an alerting-system outage must not
    // abort or fail the poll cycle it's trying to report on.
    const message = error instanceof Error ? error.message : String(error);
    try {
      console.error(JSON.stringify({ ts: nowIso(), level: "error", stage: "ops_alert_delivery_failed", alertId: alert.alertId, message }));
    } catch {
      // Swallow — logging must never throw either.
    }
  }
}

// ============================================================================
// FR-23 date fallback (§8 edge case: unparseable listingDateText).
// ============================================================================

function parseListingDate(dateText: string): string | null {
  if (!dateText) return null;
  const parsed = Date.parse(dateText);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

// ============================================================================
// runPollCycle (FR-1..FR-3, FR-24) — the top-level orchestration.
// ============================================================================

// FR-2: in-process mutex. §13 flags this as a known, deliberate
// single-instance-only guarantee — a distributed lock is out of scope for
// hackathon/demo deployment topology.
let pollInProgress = false;

async function processEntry(
  entry: ListingEntry,
  pollRunId: string,
  deps: WatchDependencies,
  errors: PollError[],
  emittedTriggerKeys: Set<string>
): Promise<boolean> {
  let page: FetchedCircularPage;
  try {
    page = await fetchCircularDetail(entry, deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push({ stage: "detail_fetch", detailUrl: entry.detailUrl, message, occurredAt: nowIso() });
    if (error instanceof StructuralMismatchError) {
      await raiseOpsAlert(
        {
          alertId: randomUUID(),
          severity: "critical",
          kind: "selector_mismatch",
          detailUrl: entry.detailUrl,
          message,
          pollRunId,
          occurredAt: nowIso()
        },
        deps
      );
    }
    logStage("detail_fetch_failed", { detailUrl: entry.detailUrl, message });
    return false;
  }

  let changeResult: { changeType: ChangeType; existing: Circular | null };
  try {
    changeResult = await detectChangeType(page, entry, deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push({ stage: "change_detect", detailUrl: entry.detailUrl, message, occurredAt: nowIso() });
    logStage("change_detect_failed", { detailUrl: entry.detailUrl, message });
    return false;
  }

  logStage("change_decided", { detailUrl: entry.detailUrl, changeType: changeResult.changeType, sourceHash: page.sourceHash });

  // FR-12: unchanged short-circuits — no chunking, no trigger.
  if (changeResult.changeType === "unchanged") {
    return false;
  }

  const circularId = randomUUID();
  let dateIssued = parseListingDate(entry.listingDateText);
  if (!dateIssued) {
    dateIssued = page.fetchedAt.slice(0, 10);
    logStage("listing_date_unparseable_fallback", { detailUrl: entry.detailUrl, listingDateText: entry.listingDateText, fallbackDate: dateIssued });
  }
  const dateEffective = dateIssued;

  let clauses: ClauseCandidate[];
  try {
    clauses = chunkIntoClauses(page.canonicalText, circularId, dateEffective);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push({ stage: "clean_chunk", detailUrl: entry.detailUrl, message, occurredAt: nowIso() });
    logStage("clean_chunk_failed", { detailUrl: entry.detailUrl, message });
    return false;
  }

  let supersedesCircularId: string | null = null;
  let amendmentContext: AmendmentContext | null = null;

  if (changeResult.changeType === "amendment") {
    // FR-13: full-document supersession.
    supersedesCircularId = changeResult.existing?.circular_id ?? null;
  } else {
    // FR-16..FR-19: changeType === "new" — look for paragraph-level
    // amendment signals against the same candidate pool detectChangeType
    // already resolved (see the module doc comment in
    // packages/graph-db/src/repositories/circular-lookups.ts for why the
    // fuzzy-scoring boundary is designed this way).
    try {
      const category = entry.listingCategoryHint || "uncategorized";
      const amendmentCandidates = await deps.findCircularsByTitleFuzzy(entry.listingTitle, category);
      amendmentContext = extractAmendmentContext(page.canonicalText, amendmentCandidates);
    } catch (error) {
      // FR-19's spirit: amendment-context resolution failing must not
      // block ingestion of the underlying circular.
      logStage("amendment_context_lookup_failed", {
        detailUrl: entry.detailUrl,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const circular: CircularCandidate = {
    circular_id: circularId,
    title: entry.listingTitle,
    // Watch has no reliable structural signal to classify circular "type"
    // beyond the listing page's own text — a generic default, not a
    // guess dressed up as certainty.
    type: "circular",
    category: entry.listingCategoryHint || "uncategorized",
    date_issued: dateIssued,
    date_effective: dateEffective,
    source_hash: page.sourceHash,
    supersedes_circular_id: supersedesCircularId,
    valid_from: dateEffective,
    valid_to: null,
    recorded_at: null
  };

  const triggerKey = `${pollRunId}:${circularId}`;
  if (emittedTriggerKeys.has(triggerKey)) {
    // FR-24 defense-in-depth: this loop only ever visits a given entry
    // once per poll run, so this branch should be unreachable in
    // practice — kept as an explicit, logged guard rather than a silent
    // assumption.
    logStage("trigger_skipped_duplicate", { pollRunId, circularId });
    return false;
  }
  emittedTriggerKeys.add(triggerKey);

  const event: RegulatoryWatchTriggerEvent = {
    eventId: randomUUID(),
    pollRunId,
    emittedAt: nowIso(),
    changeType: changeResult.changeType,
    circular,
    clauses,
    amendmentContext
  };

  try {
    await emitTrigger(event, deps);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push({ stage: "trigger_emit", detailUrl: entry.detailUrl, message, occurredAt: nowIso() });
    logStage("trigger_emit_failed", { eventId: event.eventId, pollRunId, circularId, message });
    return false;
  }
}

async function executePollCycle(pollRunId: string, startedAt: string, deps: WatchDependencies): Promise<PollRun> {
  const errors: PollError[] = [];
  const listingUrlsPolled: string[] = [];
  const emittedTriggerKeys = new Set<string>();
  let entriesSeen = 0;
  let triggersEmitted = 0;

  for (const listingUrl of deps.listingUrls) {
    listingUrlsPolled.push(listingUrl);

    let entries: ListingEntry[];
    try {
      entries = await fetchListingEntries(listingUrl, deps);
    } catch (error) {
      // NFR/§8: listing page itself unreachable — more severe than a
      // single detail page failing.
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ stage: "listing_fetch", detailUrl: listingUrl, message, occurredAt: nowIso() });
      await raiseOpsAlert(
        {
          alertId: randomUUID(),
          severity: "critical",
          kind: "upstream_unavailable",
          detailUrl: listingUrl,
          message: `Listing page unreachable after retries: ${message}`,
          pollRunId,
          occurredAt: nowIso()
        },
        deps
      );
      logStage("listing_fetch_failed", { listingUrl, message });
      continue; // FR-6: partial failure isolation across URLs
    }

    const previousRowCount = deps.rowCountHistory.get(listingUrl);

    // FR-5: zero rows where the prior successful poll saw >= 1 is a
    // probable markup change, not "no new circulars."
    if (entries.length === 0 && previousRowCount !== undefined && previousRowCount >= 1) {
      const message = `LISTING_CONFIG.rowSelector matched 0 rows (previous successful poll matched ${previousRowCount}).`;
      errors.push({ stage: "listing_fetch", detailUrl: listingUrl, message, occurredAt: nowIso() });
      await raiseOpsAlert(
        { alertId: randomUUID(), severity: "critical", kind: "selector_mismatch", detailUrl: listingUrl, message, pollRunId, occurredAt: nowIso() },
        deps
      );
      logStage("listing_selector_mismatch", { listingUrl, previousRowCount });
      continue; // do not fabricate empty results into the graph
    }

    // §8: large positive jump (>= 10x) — not blocked, logged as a warning
    // so an operator can sanity-check trigger volume.
    if (previousRowCount !== undefined && previousRowCount > 0 && entries.length >= previousRowCount * 10) {
      logStage("listing_row_count_jump_warning", { listingUrl, previousRowCount, newRowCount: entries.length });
    }

    if (entries.length > 0) {
      deps.rowCountHistory.set(listingUrl, entries.length);
    }

    entriesSeen += entries.length;

    // NFR "Rate limiting / politeness": bounded concurrency + minimum
    // delay between batches to the same host.
    for (let i = 0; i < entries.length; i += deps.detailFetchConcurrency) {
      const batch = entries.slice(i, i + deps.detailFetchConcurrency);
      const results = await Promise.all(batch.map((entry) => processEntry(entry, pollRunId, deps, errors, emittedTriggerKeys)));
      triggersEmitted += results.filter(Boolean).length;
      if (i + deps.detailFetchConcurrency < entries.length) {
        await deps.sleep(deps.interRequestDelayMs);
      }
    }
  }

  const finishedAt = nowIso();
  const pollRun: PollRun = { pollRunId, startedAt, finishedAt, listingUrlsPolled, entriesSeen, triggersEmitted, errors };
  logStage("poll_run_completed", { pollRunId, entriesSeen, triggersEmitted, errorCount: errors.length });
  return pollRun;
}

export async function runPollCycle(depsOverride: Partial<WatchDependencies> = {}): Promise<PollRun> {
  const deps = mergeDeps(depsOverride);
  const pollRunId = randomUUID();
  const startedAt = nowIso();

  if (pollInProgress) {
    // FR-2: skip, do not queue.
    await raiseOpsAlert(
      {
        alertId: randomUUID(),
        severity: "warning",
        kind: "concurrent_run_skipped",
        detailUrl: null,
        message: "A poll cycle is already in progress; this scheduled/triggered tick was skipped, not queued.",
        pollRunId,
        occurredAt: nowIso()
      },
      deps
    );
    logStage("poll_run_skipped_concurrent", { pollRunId });
    return {
      pollRunId,
      startedAt,
      finishedAt: nowIso(),
      listingUrlsPolled: [],
      entriesSeen: 0,
      triggersEmitted: 0,
      errors: []
    };
  }

  pollInProgress = true;
  logStage("poll_run_started", { pollRunId, listingUrlCount: deps.listingUrls.length });
  try {
    return await executePollCycle(pollRunId, startedAt, deps);
  } finally {
    pollInProgress = false;
  }
}

// ============================================================================
// Preserved export — orchestrator.workflow.ts's `trigger:
// regulatoryWatchAgent.name` reference depends on this exact shape.
// ============================================================================

export const regulatoryWatchAgent = {
  name: "regulatory-watch-and-ingestion",
  description:
    "Polls SEBI circular listings, detects new/amended circulars, cleans and chunks text for the Orchestrator."
};
