import type { ChatMessage, Citation } from "@sentinel-act/assistant-core";
import { LineageBreadcrumb } from "@sentinel-act/ui/components/governance/lineage-breadcrumb";
import { cn } from "@sentinel-act/ui/lib/utils";

/** §4.6: citations render as a row of deep links back to the graph — the
 *  spec's own words are "one click deep, per UX brief section 4 ('The
 *  lineage')", the exact design LineageBreadcrumb (packages/ui) was built
 *  for. A chat message's citations are a flat list (Circular, Clause,
 *  Obligation, ProcessTask, HumanReview mixed together, not a hierarchy),
 *  so this reuses that same component with its steps rendered as
 *  independent links rather than a parent -> child chain — visually
 *  consistent with the audit screen's own citation-styled provenance links
 *  without inventing a second, parallel "citation chip" component. */
function citationsToSteps(citations: Citation[]) {
  return citations.map((citation) => ({ label: citation.label, href: citation.href }));
}

const RETRIEVAL_MODE_LABEL: Record<NonNullable<ChatMessage["retrievalMode"]>, string> = {
  structured: "structured lookup",
  vector: "semantic search",
  none: "no graph query"
};

export function ChatMessageView({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";

  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] space-y-2 rounded-lg px-3 py-2 text-sm",
          isUser ? "bg-secondary text-secondary-foreground" : "border border-border bg-card"
        )}
      >
        <p className="whitespace-pre-wrap">{message.content}</p>

        {!isUser && message.citations && message.citations.length > 0 ? (
          <div className="space-y-1 border-t border-border/60 pt-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Sources</p>
            <LineageBreadcrumb steps={citationsToSteps(message.citations)} />
          </div>
        ) : null}

        {!isUser && message.retrievalMode && message.retrievalMode !== "none" ? (
          <p className="text-[11px] text-muted-foreground">via {RETRIEVAL_MODE_LABEL[message.retrievalMode]}</p>
        ) : null}
      </div>
    </div>
  );
}
