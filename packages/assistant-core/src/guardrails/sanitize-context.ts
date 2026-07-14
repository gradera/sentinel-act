// sanitize-context.ts — Spec 12 §6, FR-13. Every piece of retrieved text
// passed into the synthesis prompt (Clause.text, Obligation.requirement_text/
// trigger_event/deadline_rule/responsible_role/penalty_ref,
// HumanReview.rationale, Circular.title, ProcessTask.task_name) is wrapped
// in an explicit, clearly labelled data delimiter before it is ever
// interpolated into an LLM prompt — this file is where that happens.
// Control characters are stripped first; an injection heuristic scanner
// flags (never blocks — §8, §13 Open Question 7) phrases that look like an
// attempt to redirect the model.
import type { AssistantGraphContext } from "@sentinel-act/graph-db";
import type { CitationType } from "../types.js";

/** Strips ASCII control characters (except normal whitespace) from
 *  retrieved text before it enters a prompt — a cheap, deterministic first
 *  line of defense against terminal-escape or invisible-character tricks,
 *  independent of whatever the heuristic scanner below does or doesn't
 *  catch. */
export function stripControlCharacters(text: string): string {
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

/** Neutralizes any literal `<<<` sequence already present INSIDE a
 *  retrieved field's own text, before that text is wrapped in this file's
 *  real `<<<UNTRUSTED_DATA ...>>>`/`<<<END_UNTRUSTED_DATA>>>` delimiters.
 *
 *  Without this, a graph node whose text was itself attacker-influenced
 *  (e.g. a HumanReview.rationale or Obligation.requirement_text crafted to
 *  contain the literal string `<<<END_UNTRUSTED_DATA>>>` followed by
 *  fake-looking "trusted" instructions) could forge a fake closing
 *  boundary and make everything after it in the prompt LOOK, to the
 *  synthesis model, like it fell outside the untrusted-data wrapper —
 *  effectively spoofing the one mechanism (FR-13) this file exists to
 *  provide. Discovered during Task 15's adversarial fixture design, not by
 *  the original Task 8 guardrails work — flagged and fixed here rather
 *  than only documented, since the fix is cheap and directly strengthens
 *  the exact guarantee FR-13 asks for ("every piece of retrieved text ...
 *  wrapped in an explicit ... delimiter" only actually holds if the
 *  delimiter can't be forged from inside the wrapped text).
 *
 *  This is defense-in-depth, not the primary safety guarantee — even a
 *  fully successful delimiter spoof can only change the synthesis
 *  model's ANSWER TEXT (it still has zero tools, §5.7, and can still only
 *  cite ids present in context, whitelisted by citation-validator.ts) —
 *  but "the untrusted-data boundary itself can be forged" is a real gap
 *  worth closing regardless of how bounded its blast radius already is. */
export function neutralizeLiteralDelimiters(text: string): string {
  return text.replace(/<<</g, "‹‹‹");
}

/** Logging-only heuristic patterns (§8, §13 Open Question 7): regulatory
 *  text legitimately uses words like "instructions" or "directives," so a
 *  hard block on phrase-matching would false-positive with no real
 *  security benefit given the structural guardrails (zero-tool agents,
 *  parameterized-only Cypher, citation whitelisting) already bound the
 *  blast radius. These patterns exist purely to produce the NFR-6
 *  observability signal — never to reject or alter the retrieved text. */
const INJECTION_HEURISTIC_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+|any\s+)?(prior|previous|the\s+above)\s+instructions?/i,
  /disregard\s+(all\s+|any\s+)?(prior|previous|the\s+above)\b/i,
  /reveal\s+(your\s+|the\s+)?system\s+prompt/i,
  /you\s+are\s+now\b/i,
  /pretend\s+(this|that|it)\s+(was|is)\s+approved/i,
  /mark\s+(this|it)\s+as\s+(reviewed|approved|committed)/i,
  /\bDETACH\s+DELETE\b/i,
  /\bCREATE\s*\(/i,
  /\bMERGE\s*\(/i,
  /\bDROP\s+(INDEX|CONSTRAINT|DATABASE)\b/i
];

/** Returns the source text of every heuristic pattern that matched —
 *  empty array means nothing was flagged. Logging-only; the caller never
 *  uses a non-empty result to block or rewrite anything (§8). */
export function scanForInjectionHeuristics(text: string): string[] {
  return INJECTION_HEURISTIC_PATTERNS.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);
}

const DELIMITER_OPEN = (nodeType: string, nodeId: string, field: string) =>
  `<<<UNTRUSTED_DATA type="${nodeType}" id="${nodeId}" field="${field}">>>`;
const DELIMITER_CLOSE = "<<<END_UNTRUSTED_DATA>>>";

interface RetrievedTextField {
  nodeType: CitationType;
  nodeId: string;
  fieldName: string;
  text: string;
}

/** Anomaly record for NFR-6: "any turn where a heuristic pattern matched
 *  retrieved text MUST be logged at warn level as a possible
 *  hallucination/injection anomaly." */
export interface InjectionAnomaly {
  nodeType: CitationType;
  nodeId: string;
  field: string;
  matchedPatterns: string[];
}

export interface ContextSanitizationResult {
  /** Ready to interpolate into the synthesis user message — every
   *  retrieved fact is individually delimited and labelled with its
   *  source node type/id/field. */
  contextBlock: string;
  injectionAnomalies: InjectionAnomaly[];
}

function collectTextFields(context: AssistantGraphContext): RetrievedTextField[] {
  const fields: RetrievedTextField[] = [];

  for (const circular of context.circulars) {
    fields.push({ nodeType: "Circular", nodeId: circular.circular_id, fieldName: "title", text: circular.title });
  }
  for (const clause of context.clauses) {
    fields.push({ nodeType: "Clause", nodeId: clause.clause_id, fieldName: "text", text: clause.text });
  }
  for (const obligation of context.obligations) {
    fields.push({
      nodeType: "Obligation",
      nodeId: obligation.obligation_id,
      fieldName: "requirement_text",
      text: obligation.requirement_text
    });
    fields.push({
      nodeType: "Obligation",
      nodeId: obligation.obligation_id,
      fieldName: "trigger_event",
      text: obligation.trigger_event
    });
    fields.push({
      nodeType: "Obligation",
      nodeId: obligation.obligation_id,
      fieldName: "deadline_rule",
      text: obligation.deadline_rule
    });
    fields.push({
      nodeType: "Obligation",
      nodeId: obligation.obligation_id,
      fieldName: "responsible_role",
      text: obligation.responsible_role
    });
    if (obligation.penalty_ref) {
      fields.push({
        nodeType: "Obligation",
        nodeId: obligation.obligation_id,
        fieldName: "penalty_ref",
        text: obligation.penalty_ref
      });
    }
  }
  for (const task of context.processTasks) {
    fields.push({ nodeType: "ProcessTask", nodeId: task.task_id, fieldName: "task_name", text: task.task_name });
  }
  for (const review of context.humanReviews) {
    if (review.rationale) {
      fields.push({ nodeType: "HumanReview", nodeId: review.review_id, fieldName: "rationale", text: review.rationale });
    }
  }

  // Blank placeholder fields (e.g. an audit-row-derived Obligation whose
  // lineage enrichment failed, structured-retrieval.ts) carry nothing to
  // sanitize or scan — dropping them keeps the prompt free of empty
  // delimited blocks that would only waste tokens.
  return fields.filter((field) => field.text.trim().length > 0);
}

/** FR-13: wraps every retrieved text field in an explicit, labelled
 *  delimiter and runs the (logging-only) injection heuristic scanner over
 *  each one. Returns the assembled prompt block plus every flagged
 *  anomaly, for the caller (synthesize-answer.ts / index.ts) to log at
 *  `warn` level per NFR-6 — this function itself never blocks or alters
 *  content based on what the scanner finds. */
export function sanitizeAssistantGraphContext(context: AssistantGraphContext): ContextSanitizationResult {
  const fields = collectTextFields(context);
  const blocks: string[] = [];
  const injectionAnomalies: InjectionAnomaly[] = [];

  for (const field of fields) {
    // Order matters: scan for the heuristic patterns against the
    // control-character-stripped text (patterns are about words/phrases,
    // unaffected by the delimiter-neutralization step below), but the
    // delimiter-forgery neutralization must run before this text is ever
    // concatenated next to a real delimiter.
    const stripped = stripControlCharacters(field.text);
    const matchedPatterns = scanForInjectionHeuristics(stripped);
    if (matchedPatterns.length > 0) {
      injectionAnomalies.push({ nodeType: field.nodeType, nodeId: field.nodeId, field: field.fieldName, matchedPatterns });
    }
    const safeText = neutralizeLiteralDelimiters(stripped);
    blocks.push(`${DELIMITER_OPEN(field.nodeType, field.nodeId, field.fieldName)}\n${safeText}\n${DELIMITER_CLOSE}`);
  }

  return {
    contextBlock: blocks.length > 0 ? blocks.join("\n\n") : "(no retrieved data for this turn)",
    injectionAnomalies
  };
}
