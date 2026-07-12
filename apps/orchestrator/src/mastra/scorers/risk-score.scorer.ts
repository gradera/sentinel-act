// Deterministic risk scorer used by Mapping and Risk Scoring.
// Inputs mirror ProcessTask.risk_score's stated drivers: penalty
// severity, deadline proximity, and whether the change touches a
// currently live Obligation.

export interface RiskScoreInputs {
  penaltySeverity: number; // 0..1
  deadlineProximityDays: number;
  overwritesLiveObligation: boolean;
}

export function scoreRisk({ penaltySeverity, deadlineProximityDays, overwritesLiveObligation }: RiskScoreInputs): number {
  const deadlineWeight = Math.max(0, 1 - deadlineProximityDays / 30); // closer deadline -> higher weight
  const overwriteWeight = overwritesLiveObligation ? 0.3 : 0;
  const raw = penaltySeverity * 0.5 + deadlineWeight * 0.3 + overwriteWeight;
  return Math.min(1, Math.max(0, raw));
}
