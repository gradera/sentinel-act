// readonly-driver.test.ts (Spec 12 §10): getAssistantReadOnlyDriver()
// fails fast when SENTINEL_NEO4J_ASSISTANT_USER/_PASSWORD are unset and no
// documented local-dev fallback flag is set (FR-23, §13 Open Question 3);
// the shared-credential fallback only activates behind the explicit opt-in
// flag, and always logs ASSISTANT_READONLY_DB_ROLE_NOT_CONFIGURED when used.
// Uses vi.resetModules()+dynamic import per test since the module memoizes
// a singleton across calls within its own lifetime.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = [
  "SENTINEL_NEO4J_URI",
  "SENTINEL_NEO4J_USER",
  "SENTINEL_NEO4J_PASSWORD",
  "SENTINEL_NEO4J_DATABASE",
  "SENTINEL_NEO4J_ASSISTANT_URI",
  "SENTINEL_NEO4J_ASSISTANT_USER",
  "SENTINEL_NEO4J_ASSISTANT_PASSWORD",
  "SENTINEL_NEO4J_ASSISTANT_DATABASE",
  "ASSISTANT_ALLOW_SHARED_CREDENTIAL_FALLBACK"
] as const;

async function freshModule() {
  vi.resetModules();
  // Import errors.js through the same reset module registry as
  // readonly-driver.js so `instanceof GraphDbUnavailableError` checks
  // below compare against the identical class object the module under
  // test actually throws (vi.resetModules() gives each import() call a
  // fresh module instance, including for transitive dependencies).
  const [driverModule, errorsModule] = await Promise.all([
    import("../src/readonly-driver.js"),
    import("../src/errors.js")
  ]);
  return { ...driverModule, GraphDbUnavailableError: errorsModule.GraphDbUnavailableError };
}

describe("getAssistantReadOnlyDriver", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
  });

  it("throws GraphDbUnavailableError if SENTINEL_NEO4J_ASSISTANT_URI and SENTINEL_NEO4J_URI are both unset", async () => {
    const { getAssistantReadOnlyDriver, GraphDbUnavailableError } = await freshModule();
    expect(() => getAssistantReadOnlyDriver()).toThrow(GraphDbUnavailableError);
  });

  it("throws GraphDbUnavailableError if assistant user/password are unset and the fallback flag is not set", async () => {
    process.env.SENTINEL_NEO4J_ASSISTANT_URI = "bolt://localhost:7687";
    const { getAssistantReadOnlyDriver, GraphDbUnavailableError } = await freshModule();
    expect(() => getAssistantReadOnlyDriver()).toThrow(GraphDbUnavailableError);
    expect(() => getAssistantReadOnlyDriver()).toThrow(/SENTINEL_NEO4J_ASSISTANT_USER/);
  });

  it("never falls back to the shared read/write credential when the opt-in flag is unset, even if shared creds exist", async () => {
    process.env.SENTINEL_NEO4J_ASSISTANT_URI = "bolt://localhost:7687";
    process.env.SENTINEL_NEO4J_USER = "neo4j";
    process.env.SENTINEL_NEO4J_PASSWORD = "shared-password";
    const { getAssistantReadOnlyDriver, GraphDbUnavailableError } = await freshModule();
    expect(() => getAssistantReadOnlyDriver()).toThrow(GraphDbUnavailableError);
  });

  it("falls back to SENTINEL_NEO4J_URI when SENTINEL_NEO4J_ASSISTANT_URI is unset", async () => {
    process.env.SENTINEL_NEO4J_URI = "bolt://localhost:7687";
    process.env.SENTINEL_NEO4J_ASSISTANT_USER = "assistant-ro";
    process.env.SENTINEL_NEO4J_ASSISTANT_PASSWORD = "assistant-password";
    const { getAssistantReadOnlyDriver } = await freshModule();
    expect(() => getAssistantReadOnlyDriver()).not.toThrow();
  });

  it("constructs successfully with distinct assistant credentials and does not log the fallback warning", async () => {
    process.env.SENTINEL_NEO4J_ASSISTANT_URI = "bolt://localhost:7687";
    process.env.SENTINEL_NEO4J_ASSISTANT_USER = "assistant-ro";
    process.env.SENTINEL_NEO4J_ASSISTANT_PASSWORD = "assistant-password";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { getAssistantReadOnlyDriver } = await freshModule();
    const driver = getAssistantReadOnlyDriver();

    expect(driver).toBeDefined();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("memoizes the singleton across repeated calls", async () => {
    process.env.SENTINEL_NEO4J_ASSISTANT_URI = "bolt://localhost:7687";
    process.env.SENTINEL_NEO4J_ASSISTANT_USER = "assistant-ro";
    process.env.SENTINEL_NEO4J_ASSISTANT_PASSWORD = "assistant-password";
    const { getAssistantReadOnlyDriver } = await freshModule();

    const first = getAssistantReadOnlyDriver();
    const second = getAssistantReadOnlyDriver();

    expect(first).toBe(second);
  });

  it("falls back to the shared read/write credential when the opt-in flag is set, and logs ASSISTANT_READONLY_DB_ROLE_NOT_CONFIGURED at error level", async () => {
    process.env.SENTINEL_NEO4J_ASSISTANT_URI = "bolt://localhost:7687";
    process.env.SENTINEL_NEO4J_USER = "neo4j";
    process.env.SENTINEL_NEO4J_PASSWORD = "shared-password";
    process.env.ASSISTANT_ALLOW_SHARED_CREDENTIAL_FALLBACK = "true";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { getAssistantReadOnlyDriver, ASSISTANT_READONLY_DB_ROLE_NOT_CONFIGURED } = await freshModule();
    const driver = getAssistantReadOnlyDriver();

    expect(driver).toBeDefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const loggedPayload = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(loggedPayload.level).toBe("error");
    expect(loggedPayload.code).toBe(ASSISTANT_READONLY_DB_ROLE_NOT_CONFIGURED);
    expect(loggedPayload.code).toBe("ASSISTANT_READONLY_DB_ROLE_NOT_CONFIGURED");

    errorSpy.mockRestore();
  });

  it("throws if the fallback flag is set but the shared credential is also missing", async () => {
    process.env.SENTINEL_NEO4J_ASSISTANT_URI = "bolt://localhost:7687";
    process.env.ASSISTANT_ALLOW_SHARED_CREDENTIAL_FALLBACK = "true";
    const { getAssistantReadOnlyDriver, GraphDbUnavailableError } = await freshModule();
    expect(() => getAssistantReadOnlyDriver()).toThrow(GraphDbUnavailableError);
  });

  it("closeAssistantReadOnlyDriver resets the singleton so a subsequent call reconstructs it", async () => {
    process.env.SENTINEL_NEO4J_ASSISTANT_URI = "bolt://localhost:7687";
    process.env.SENTINEL_NEO4J_ASSISTANT_USER = "assistant-ro";
    process.env.SENTINEL_NEO4J_ASSISTANT_PASSWORD = "assistant-password";
    const { getAssistantReadOnlyDriver, closeAssistantReadOnlyDriver } = await freshModule();

    const first = getAssistantReadOnlyDriver();
    await closeAssistantReadOnlyDriver();
    const second = getAssistantReadOnlyDriver();

    expect(first).not.toBe(second);
  });
});
