// Spec 12 — Conversational Assistant. Adjacent surface to Journey F,
// deliberately styled distinct from the console: read-only, cannot
// approve/reject/commit anything (§2, three-layer enforcement — FR-21
// session.executeRead, FR-22 ESLint import-boundary, FR-23 distinct
// read-only Neo4j credential — all enforced below this page, in
// app/api/assistant/query/route.ts and packages/assistant-core, not here).
//
// This was a static placeholder (`<div>` with the dashed-border treatment
// inline) before Task 14 — now reuses the shared `ReadOnlyBanner`
// component (packages/ui, itself generalized FROM this exact page's
// original inline markup, see that component's own doc comment) and
// mounts the interactive chat surface. `ChatPanel` is the one Client
// Component boundary on this page — everything else here can stay a
// Server Component with no data of its own to fetch (no server-side
// session/history in v1, §13 Open Question 4).
import { ReadOnlyBanner } from "@sentinel-act/ui/components/governance/read-only-banner";
import { ChatPanel } from "@/components/assistant/chat-panel";

export default function AssistantPage() {
  return (
    <main className="mx-auto max-w-3xl space-y-4 p-8">
      <ReadOnlyBanner title="Conversational Assistant — read only">
        Ask a plain-English question about the Regulatory Knowledge Graph — obligations, circulars, review history,
        or categories. Every answer is grounded in retrieved graph data with citations back to the source; this
        surface can never approve, reject, edit, or commit anything.
      </ReadOnlyBanner>

      <h1 className="text-lg font-semibold">Conversational Assistant</h1>

      <ChatPanel />
    </main>
  );
}
