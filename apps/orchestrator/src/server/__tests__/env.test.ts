// Spec 15 §10 Test Plan — env-validation module test: a missing required
// var (SENTINEL_NEO4J_URI, the spec's own worked example) throws a clear
// startup error, and a fully-populated .env.example-shaped input
// validates successfully.
import { describe, expect, it } from "vitest";
import { OrchestratorEnvValidationError, validateOrchestratorEnv } from "../env.js";

const FULLY_POPULATED_ENV = {
  SENTINEL_NEO4J_URI: "neo4j://localhost:7687",
  SENTINEL_NEO4J_USER: "neo4j",
  SENTINEL_NEO4J_PASSWORD: "sentinel-local-dev-password",
  SENTINEL_AUDIT_LEDGER_DATABASE_URL: "postgres://sentinel:sentinel@localhost:5432/sentinel_ledger",
  SENTINEL_SERVICE_JWT_SECRET: "dev-only-placeholder-not-a-real-secret",
  MODEL_PROVIDER_API_KEY: "test-key"
};

describe("validateOrchestratorEnv", () => {
  it("validates successfully against a fully-populated .env.example-shaped input", () => {
    expect(() => validateOrchestratorEnv(FULLY_POPULATED_ENV)).not.toThrow();
  });

  it("throws OrchestratorEnvValidationError with a clear message when SENTINEL_NEO4J_URI is missing", () => {
    const { SENTINEL_NEO4J_URI, ...rest } = FULLY_POPULATED_ENV;
    void SENTINEL_NEO4J_URI; // destructured only to omit it from `rest` below
    expect(() => validateOrchestratorEnv(rest)).toThrow(OrchestratorEnvValidationError);
    try {
      validateOrchestratorEnv(rest);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestratorEnvValidationError);
      expect((err as Error).message).toContain("SENTINEL_NEO4J_URI");
    }
  });

  it("reports every missing required var at once, not just the first", () => {
    try {
      validateOrchestratorEnv({});
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("SENTINEL_NEO4J_URI");
      expect(message).toContain("SENTINEL_AUDIT_LEDGER_DATABASE_URL");
      expect(message).toContain("MODEL_PROVIDER_API_KEY");
    }
  });

  it("does not require optional/degrade-gracefully vars (Slack, Ticketing)", () => {
    // Deliberately no SLACK_BOT_TOKEN/SLACK_SIGNING_SECRET/TICKETING_* —
    // matches this codebase's existing SlackConfigError-based graceful
    // degradation (slack/app.ts), not a hard startup requirement.
    expect(() => validateOrchestratorEnv(FULLY_POPULATED_ENV)).not.toThrow();
  });
});
