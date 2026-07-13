// Spec 11 §5.1 — minimal typed shapes for Slack's interactivity envelope
// (block_actions | view_submission | view_closed) and the Events API
// payloads this unit subscribes to (app_uninstalled/tokens_revoked only —
// §8, §11 Task 10). Hand-typed rather than pulling in @slack/bolt's
// larger type surface, consistent with this unit's zero-new-runtime-
// dependency approach (slack-client.ts's header comment).

export interface SlackBlockActionElement {
  action_id: string;
  block_id: string;
  value?: string;
  type: string;
}

export interface SlackContainer {
  channel_id?: string;
  message_ts?: string;
}

export interface SlackBlockActionsPayload {
  type: "block_actions";
  user: { id: string; team_id?: string };
  trigger_id: string;
  actions: SlackBlockActionElement[];
  container?: SlackContainer;
  channel?: { id: string };
  message?: { ts: string };
}

export interface SlackViewSubmissionPayload {
  type: "view_submission";
  user: { id: string; team_id?: string };
  view: {
    id: string;
    callback_id: string;
    private_metadata: string;
    state: {
      values: Record<string, Record<string, { type: string; value?: string | null }>>;
    };
  };
}

export interface SlackViewClosedPayload {
  type: "view_closed";
  user: { id: string; team_id?: string };
  view: { id: string; callback_id: string };
}

export type SlackInteractivityPayload = SlackBlockActionsPayload | SlackViewSubmissionPayload | SlackViewClosedPayload;

export function parseInteractivityPayload(raw: unknown): SlackInteractivityPayload | null {
  if (typeof raw !== "object" || raw === null || !("type" in raw)) {
    return null;
  }
  const type = (raw as { type: unknown }).type;
  if (type === "block_actions" || type === "view_submission" || type === "view_closed") {
    return raw as SlackInteractivityPayload;
  }
  return null;
}

/** Reads the rationale_input value out of a view_submission's state
 *  (§5.4's rationale_block/rationale_input block_id/action_id). Returns
 *  an empty string (never null/undefined) when absent so FR-14's
 *  empty/whitespace-only check has a single normalized shape to test. */
export function extractRationaleValue(payload: SlackViewSubmissionPayload): string {
  return payload.view.state.values.rationale_block?.rationale_input?.value ?? "";
}

// ---------------------------------------------------------------------------
// Events API (app_uninstalled / tokens_revoked, §8, §11 Task 10).
// ---------------------------------------------------------------------------

export interface SlackAppUninstalledEvent {
  type: "app_uninstalled";
}

export interface SlackTokensRevokedEvent {
  type: "tokens_revoked";
  tokens: { oauth?: string[]; bot?: string[] };
}

export interface SlackEventsEnvelope {
  type: "event_callback" | "url_verification";
  team_id?: string;
  event?: SlackAppUninstalledEvent | SlackTokensRevokedEvent;
  challenge?: string; // url_verification handshake
}
