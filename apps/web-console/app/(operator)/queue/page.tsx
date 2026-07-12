import { Card, CardHeader, CardTitle, CardContent } from "@sentinel-act/ui/components/ui/card";
import { RiskTierBadge } from "@sentinel-act/ui/components/governance/risk-tier-badge";
import { ConfidenceBadge } from "@sentinel-act/ui/components/governance/confidence-badge";

// Journey A / B entry point (UX brief §5): reviewer queue, sorted by risk
// score and time-to-SLA, not arrival order — "a reviewer's first question
// is always 'what's about to breach'". Demo data only; wire to the
// Orchestrator's read API once apps/orchestrator exposes one.
const QUEUE_DEMO = [
  {
    id: "OBL-2026-0731",
    summary: "CUSPA auto-pledge: client unpaid securities reporting deadline",
    tier: "C" as const,
    confidence: 0.94,
    slaHoursLeft: 3
  },
  {
    id: "OBL-2026-0729",
    summary: "Investment Adviser disclosure format update",
    tier: "B" as const,
    confidence: 0.81,
    slaHoursLeft: 18
  }
];

export default function QueuePage() {
  return (
    <main className="mx-auto max-w-3xl space-y-4 p-8">
      <h1 className="text-lg font-semibold">Reviewer queue — Operator mode</h1>
      <div className="space-y-3">
        {QUEUE_DEMO.map((item) => (
          <Card key={item.id}>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-sm">{item.id}</CardTitle>
              <RiskTierBadge tier={item.tier} />
            </CardHeader>
            <CardContent className="flex items-center justify-between text-sm">
              <span>{item.summary}</span>
              <div className="flex items-center gap-2">
                <ConfidenceBadge score={item.confidence} />
                <span className="text-xs text-muted-foreground">SLA: {item.slaHoursLeft}h left</span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </main>
  );
}
