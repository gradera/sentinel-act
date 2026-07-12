// Mapping and Risk Scoring Agent — deliberately NOT an LLM call.
// Deterministic, rules-based: maps an Obligation to a ProcessTask and
// computes risk_score from penalty severity, deadline proximity, and
// whether it touches a currently live obligation. This score is what
// the Tier A/B/C Router acts on.
export const mappingRiskScoringAgent = {
  name: "mapping-and-risk-scoring",
  description: "Deterministically maps an Obligation to a ProcessTask and computes its risk_score."
};
