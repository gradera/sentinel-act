// Spec 15 §10 Test Plan — env-validation module test for this app,
// mirroring apps/orchestrator/src/server/__tests__/env.test.ts's contract.
import { describe, expect, it } from "vitest";
import { WebConsoleEnvValidationError, validateWebConsoleEnv } from "./env";

const FULLY_POPULATED_ENV = {
  // NODE_ENV: Next.js's own ambient NodeJS.ProcessEnv augmentation makes
  // this required on the type (not just in this app's runtime env), so
  // every fixture object below needs it to satisfy validateWebConsoleEnv's
  // `NodeJS.ProcessEnv` parameter type — unrelated to webConsoleEnvSchema
  // itself, which does not require or validate NODE_ENV.
  NODE_ENV: "test",
  ORCHESTRATOR_BASE_URL: "http://localhost:4111",
  SENTINEL_SERVICE_JWT_SECRET: "dev-only-placeholder-not-a-real-secret",
  REVIEWER_SESSION_SECRET: "dev-only-placeholder-not-a-real-secret",
  NEXT_PUBLIC_ENVIRONMENT_TIER: "local"
} as const;

describe("validateWebConsoleEnv", () => {
  it("validates successfully against a fully-populated .env.example-shaped input", () => {
    expect(() => validateWebConsoleEnv(FULLY_POPULATED_ENV)).not.toThrow();
  });

  it("throws WebConsoleEnvValidationError with a clear message when ORCHESTRATOR_BASE_URL is missing", () => {
    const { ORCHESTRATOR_BASE_URL, ...rest } = FULLY_POPULATED_ENV;
    void ORCHESTRATOR_BASE_URL; // destructured only to omit it from `rest` below
    try {
      validateWebConsoleEnv(rest);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(WebConsoleEnvValidationError);
      expect((err as Error).message).toContain("ORCHESTRATOR_BASE_URL");
    }
  });

  it("rejects an invalid NEXT_PUBLIC_ENVIRONMENT_TIER value", () => {
    expect(() =>
      validateWebConsoleEnv({ ...FULLY_POPULATED_ENV, NEXT_PUBLIC_ENVIRONMENT_TIER: "not-a-real-tier" })
    ).toThrow(WebConsoleEnvValidationError);
  });

  it("does not require NEXTAUTH_SECRET/NEXTAUTH_URL (unused — next-auth is not installed)", () => {
    expect(() => validateWebConsoleEnv(FULLY_POPULATED_ENV)).not.toThrow();
  });
});
