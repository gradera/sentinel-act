// Spec 12 §5.6 `POST /api/assistant/query` — the Conversational
// Assistant's only HTTP entry point. This file's job is thin: session/role
// guard, rate limit, request-body validation, wire up the three read-only
// services `answerQuestion` (@sentinel-act/assistant-core) needs, call it,
// map errors. All the actual classify -> retrieve -> synthesize -> cite
// orchestration lives in that package, not here (§5.3).
//
// Read-only against the Regulatory Knowledge Graph, at all three of Spec
// 12's enforcement layers (§2): (1) structural — AssistantIntent has no
// write-shaped member, enforced inside assistant-core; (2) application —
// this file imports ONLY AssistantQueryService/AuditQueryService/
// getAssistantReadOnlyDriver from @sentinel-act/graph-db, matching the
// ESLint `no-restricted-imports` rule this file's own directory
// (app/api/assistant/**) is covered by (apps/web-console/eslint.config.mjs,
// Task 12) — no GraphWriter/commitProposal/repository-class import
// anywhere below, and there must never be one added; (3) database — the
// driver constructed here is `getAssistantReadOnlyDriver()`, a distinct
// singleton/credential from the app's own `getDriver()` (FR-21/FR-23),
// chosen deliberately over reusing `getDriver()` the way audit routes do,
// specifically so this route gets the full three-layer defense-in-depth
// Spec 12 describes rather than only two of the three.
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { AssistantQueryService, AuditQueryService, getAssistantReadOnlyDriver, getAssistantSingletonDatabase } from "@sentinel-act/graph-db";
import { answerQuestion, truncateConversationHistory, type AssistantQueryRequest, type ChatMessage } from "@sentinel-act/assistant-core";
import { mapAssistantError } from "@/lib/console/assistant-errors";
import { embedQuestion } from "@/lib/console/assistant-embed";
import { allowAssistantRequest, rateLimitExceededResponse } from "@/lib/console/assistant-rate-limit";
import { jsonError, mapSessionError } from "@/lib/console/route-errors";
import { ASSISTANT_ROLES, getReviewerSession, requireRole, requireSession } from "@/lib/console/session";

// §4.1's ChatMessage — validated loosely on purpose: `citations`/
// `retrievalMode` are server-authored fields the client only ever echoes
// back inside conversationHistory, never originates; the schema doesn't
// re-validate their internal shape (nothing downstream trusts a
// client-supplied citation, `synthesize-answer.ts` only ever reads
// `role`/`content` off history turns per §5.4.2's own doc comment).
const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  citations: z.array(z.unknown()).optional(),
  retrievalMode: z.enum(["structured", "vector", "none"]).optional(),
  createdAt: z.string()
});

// §5.6 request body: `question` (non-empty) + `conversationHistory`
// (defaults to `[]` when omitted — a brand-new conversation's first turn
// has no history to send).
const assistantQueryBodySchema = z.object({
  question: z.string().trim().min(1, "question must not be empty"),
  conversationHistory: z.array(chatMessageSchema).default([])
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const session = requireSession(await getReviewerSession(request));
    requireRole(session, ASSISTANT_ROLES);

    // §7 NFR-5: 20 requests/minute per reviewer by default, keyed by the
    // session's own reviewerId (never a client-supplied identifier).
    if (!allowAssistantRequest(session.reviewerId)) {
      return rateLimitExceededResponse();
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ error: "request body must be valid JSON.", field: "body" }, { status: 400 });
    }
    const parsed = assistantQueryBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return NextResponse.json({ error: issue.message, field: issue.path.join(".") || "unknown" }, { status: 400 });
    }

    // §7 NFR-5: conversationHistory sent to any LLM call is truncated
    // server-side to the trailing 6 messages — done here (before
    // answerQuestion is even called) as well as inside classify-question.ts/
    // synthesize-answer.ts, so the truncated size is also what gets
    // echoed back in logs/tests at this layer, not just deep inside the
    // orchestration.
    const assistantRequest: AssistantQueryRequest = {
      question: parsed.data.question,
      conversationHistory: truncateConversationHistory(parsed.data.conversationHistory as ChatMessage[])
    };

    const driver = getAssistantReadOnlyDriver();
    const assistantQueryService = new AssistantQueryService(driver);
    // FR-21/FR-23: AuditQueryService is also constructed against the
    // assistant's OWN read-only driver here, not apps/web-console's
    // shared `getDriver()` — every graph call this route can trigger,
    // structured or vector, goes through the distinct read-only credential
    // (when one is configured; see readonly-driver.ts's own doc comment on
    // the explicit, logged shared-credential fallback for environments
    // where a scoped Neo4j role couldn't be provisioned before the
    // deadline).
    const auditQueryService = new AuditQueryService(driver);

    const response = await answerQuestion(assistantRequest, {
      assistantQueryService,
      auditQueryService,
      neo4jSession: () => driver.session({ database: getAssistantSingletonDatabase() }),
      embedQuestion,
      referenceDateFn: () => new Date().toISOString().slice(0, 10)
    });

    return NextResponse.json(response, { status: 200 });
  } catch (err) {
    const sessionResponse = mapSessionError(err);
    if (sessionResponse) {
      return sessionResponse;
    }
    const assistantResponse = mapAssistantError(err);
    if (assistantResponse) {
      return assistantResponse;
    }
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        operation: "POST /api/assistant/query",
        message: err instanceof Error ? err.message : String(err)
      })
    );
    return jsonError(500, "INTERNAL_ERROR");
  }
}
