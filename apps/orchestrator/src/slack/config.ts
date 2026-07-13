// Spec 11 — env var contract, exactly the names apps/orchestrator/.env.example
// already lists under "Slack Channels and Signals (Spec 11)" (Spec 15 §4.1).
// §13: SLA_POLL_INTERVAL_MINUTES / SLA_DUE_SOON_WINDOW_HOURS are named
// exported constants (placeholders pending real reviewer feedback), not
// magic numbers inlined at call sites.

export const SLA_DUE_SOON_WINDOW_HOURS = Number(process.env.SLA_DUE_SOON_WINDOW_HOURS ?? 4);
export const SLA_POLL_INTERVAL_MINUTES = Number(process.env.SLA_POLL_INTERVAL_MINUTES ?? 5);

export interface SlackGatewayConfig {
  botToken: string;
  signingSecret: string;
  webConsoleBaseUrl: string;
}

export class SlackConfigError extends Error {}

/** Reads and validates the required Slack env vars once at startup.
 *  Throws SlackConfigError (never a bare Error) if a required var is
 *  missing — callers decide whether that is fatal (real deployment) or
 *  tolerable (e.g. a dev environment intentionally running without Slack
 *  wired up; see app.ts's mount function for how a missing config is
 *  handled at the route-registration level). */
export function loadSlackGatewayConfig(env: NodeJS.ProcessEnv = process.env): SlackGatewayConfig {
  const botToken = env.SLACK_BOT_TOKEN;
  const signingSecret = env.SLACK_SIGNING_SECRET;
  const webConsoleBaseUrl = env.WEB_CONSOLE_BASE_URL;

  if (!botToken) {
    throw new SlackConfigError("SLACK_BOT_TOKEN is not configured.");
  }
  if (!signingSecret) {
    throw new SlackConfigError("SLACK_SIGNING_SECRET is not configured.");
  }
  if (!webConsoleBaseUrl) {
    throw new SlackConfigError("WEB_CONSOLE_BASE_URL is not configured.");
  }

  return { botToken, signingSecret, webConsoleBaseUrl };
}
