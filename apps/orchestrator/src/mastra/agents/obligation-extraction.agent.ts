// Obligation Extraction Agent (LLM-backed).
// Turns a Clause into a structured Obligation with an initial
// confidence_score. Never writes to the graph directly — only proposes;
// the Orchestrator verifies and commits.
export const obligationExtractionAgent = {
  name: "obligation-extraction",
  description: "Extracts a structured Obligation (requirement_text, trigger_event, deadline_rule, ...) from a Clause."
};
