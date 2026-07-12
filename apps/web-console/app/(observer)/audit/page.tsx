import { LineageBreadcrumb } from "@sentinel-act/ui/components/governance/lineage-breadcrumb";

// Journey F (UX brief §5): read-only HumanReview trail. A query
// interface, not a document — filterable log/table, not a static report.
export default function AuditPage() {
  return (
    <main className="mx-auto max-w-3xl space-y-4 p-8">
      <h1 className="text-lg font-semibold">Audit lookup — Observer mode (read-only)</h1>
      <p className="text-sm text-muted-foreground">
        Search by Obligation, Circular, or reviewer. No controls visible here — situational awareness, not intervention,
        per the framework&apos;s Observer Mode definition.
      </p>
      <LineageBreadcrumb
        steps={[
          { label: "Circular 2026/07" },
          { label: "Clause 46" },
          { label: "Obligation OBL-2026-0731" },
          { label: "ProcessTask TASK-4471" }
        ]}
      />
    </main>
  );
}
