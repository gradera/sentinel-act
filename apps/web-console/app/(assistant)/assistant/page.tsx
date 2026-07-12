// Adjacent surface to Journey F: Conversational Assistant. Deliberately
// styled distinct from the console — read-only, cannot approve/reject/commit.
export default function AssistantPage() {
  return (
    <main className="mx-auto max-w-3xl space-y-4 p-8">
      <div className="rounded-md border border-dashed border-muted-foreground/40 p-4">
        <h1 className="text-lg font-semibold">Conversational Assistant</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Read-only. Ask a plain-English question, get an answer grounded with citations back to the graph. This
          surface can never approve, reject, or commit — the dashed border is intentional, matching the Observability
          Console&apos;s treatment in the architecture diagram.
        </p>
      </div>
    </main>
  );
}
