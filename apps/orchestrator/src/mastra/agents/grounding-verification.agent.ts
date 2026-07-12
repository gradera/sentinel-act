// Grounding and Verification Agent (LLM-backed, independent critic pass).
// Checks an extracted Obligation against the literal source Clause text
// and flags contradictions before any human sees them. Feeds the
// grounding_score field and can trigger the always-escalate path.
export const groundingVerificationAgent = {
  name: "grounding-and-verification",
  description: "Independently verifies an Obligation against its source Clause; flags contradictions and grounding failures."
};
