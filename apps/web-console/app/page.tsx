import Link from "next/link";
import { Card, CardHeader, CardTitle, CardContent } from "@sentinel-act/ui/components/ui/card";

// Landing screen: the three Control Modalities from the design framework
// (Observer / Operator / Builder), mapped to this system's actual personas.
// Builder mode is intentionally absent — out of scope per the UX brief (§8),
// since there is no agent/threshold configuration UI in this build yet.
const MODES = [
  {
    href: "/queue",
    title: "Operator — Reviewer queue",
    description: "Compliance Officer / Senior Compliance Officer. Tier B and C sign-off, sorted by risk and SLA."
  },
  {
    href: "/audit",
    title: "Observer — Audit lookup",
    description: "Compliance Head / auditor. Read-only HumanReview trail, searchable by Obligation, Circular, or reviewer."
  },
  {
    href: "/assistant",
    title: "Assistant — Conversational lookup",
    description: "Read-only, plain-English query over the graph. Cannot approve, reject, or commit anything."
  }
];

export default function Home() {
  return (
    <main className="mx-auto max-w-3xl space-y-4 p-8">
      <h1 className="text-xl font-semibold text-foreground">Sentinel Act — Web Governance Console</h1>
      <div className="grid gap-4 sm:grid-cols-3">
        {MODES.map((mode) => (
          <Link key={mode.href} href={mode.href}>
            <Card className="h-full transition-colors hover:border-primary">
              <CardHeader>
                <CardTitle>{mode.title}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">{mode.description}</CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </main>
  );
}
