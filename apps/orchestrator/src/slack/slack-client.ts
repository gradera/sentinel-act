// Spec 11 §5.2 — outbound calls to the Slack Web API. Hand-rolled on
// Node's built-in `fetch` (Node >=20, this repo targets Node >=20 per
// root package.json's `engines`), no `@slack/web-api`/`@slack/bolt`
// dependency — same "no framework dependency" convention
// apps/orchestrator/src/server/http-server.ts already established for
// its own hand-rolled `node:http` server (see that file's header
// comment). This keeps the Slack gateway installable with zero new
// third-party runtime dependencies, consistent with how the rest of this
// app avoids adding a web framework.
//
// NFR-RateLimit-1: Slack's documented per-method rate limits are
// respected via retry-with-backoff on 429 (Retry-After honored) — the
// SLA reminder scheduler additionally staggers its own call volume
// (sla-reminder-scheduler.ts), this module only handles the single-call
// retry contract.
// NFR-Security-2: SLACK_BOT_TOKEN/SLACK_SIGNING_SECRET are read from
// env, never logged (see logging call sites below — request/response
// bodies are logged, but never the Authorization header value itself).

const SLACK_API_BASE = "https://slack.com/api";
const MAX_RETRY_ATTEMPTS = 3;

export type SlackApiResult<T = Record<string, unknown>> = {
  ok: boolean;
  error?: string;
} & Partial<T>;

export interface SlackApiCallOptions {
  method: string; // e.g. "chat.postMessage"
  body: Record<string, unknown>;
  botToken: string;
  /** Injectable fetch for tests (nock/msw both intercept the real
   *  `fetch`/`http` layer too, but an injectable fetch keeps unit tests
   *  free of any network layer at all). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Calls one Slack Web API method with JSON body, bounded retry on 429
 *  (honoring `Retry-After` when present, otherwise exponential backoff)
 *  and on network-level failures (Bolt's documented default: max 3
 *  attempts, mirrored here since this unit does not use Bolt). Never
 *  throws on a well-formed Slack `{ ok: false, error: "..." }` response
 *  — that is a normal outcome callers branch on, not a transport failure.
 *  DOES throw if every attempt exhausts on a network-level error (caller
 *  handles per §8's "Slack Web API unavailable" row: retry, then log and
 *  give up silently from the reviewer's perspective). */
export async function callSlackApi<T = Record<string, unknown>>(options: SlackApiCallOptions): Promise<SlackApiResult<T>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxAttempts = options.maxAttempts ?? MAX_RETRY_ATTEMPTS;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(`${SLACK_API_BASE}/${options.method}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${options.botToken}`
        },
        body: JSON.stringify(options.body)
      });

      if (response.status === 429) {
        const retryAfterHeader = response.headers.get("retry-after");
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 2 ** attempt * 200;
        if (attempt < maxAttempts) {
          await delay(retryAfterMs);
          continue;
        }
      }

      const json = (await response.json()) as SlackApiResult<T>;
      return json;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await delay(2 ** attempt * 100);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`callSlackApi(${options.method}) failed after ${maxAttempts} attempts.`);
}

export interface PostMessageInput {
  botToken: string;
  channel: string;
  blocks: unknown[];
  text: string; // fallback/notification text, required by Slack for accessibility
  fetchImpl?: typeof fetch;
}

export async function postMessage(input: PostMessageInput): Promise<SlackApiResult<{ ts: string; channel: string }>> {
  return callSlackApi({
    method: "chat.postMessage",
    botToken: input.botToken,
    body: { channel: input.channel, blocks: input.blocks, text: input.text },
    fetchImpl: input.fetchImpl
  });
}

export interface UpdateMessageInput {
  botToken: string;
  channel: string;
  ts: string;
  blocks: unknown[];
  text: string;
  fetchImpl?: typeof fetch;
}

export async function updateMessage(input: UpdateMessageInput): Promise<SlackApiResult> {
  return callSlackApi({
    method: "chat.update",
    botToken: input.botToken,
    body: { channel: input.channel, ts: input.ts, blocks: input.blocks, text: input.text },
    fetchImpl: input.fetchImpl
  });
}

export interface OpenViewInput {
  botToken: string;
  triggerId: string;
  view: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}

export async function openView(input: OpenViewInput): Promise<SlackApiResult<{ view: { id: string } }>> {
  return callSlackApi({
    method: "views.open",
    botToken: input.botToken,
    body: { trigger_id: input.triggerId, view: input.view },
    fetchImpl: input.fetchImpl
  });
}

export interface UpdateViewInput {
  botToken: string;
  viewId: string;
  view: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}

export async function updateView(input: UpdateViewInput): Promise<SlackApiResult> {
  return callSlackApi({
    method: "views.update",
    botToken: input.botToken,
    body: { view_id: input.viewId, view: input.view },
    fetchImpl: input.fetchImpl
  });
}

export interface OpenConversationInput {
  botToken: string;
  slackUserId: string;
  fetchImpl?: typeof fetch;
}

export async function openConversation(input: OpenConversationInput): Promise<SlackApiResult<{ channel: { id: string } }>> {
  return callSlackApi({
    method: "conversations.open",
    botToken: input.botToken,
    body: { users: input.slackUserId },
    fetchImpl: input.fetchImpl
  });
}
