// FR-9: StaticRoleAssigneeMap — checked-in-JSON-backed RoleAssigneeMapPort.
import { describe, expect, it } from "vitest";
import { StaticRoleAssigneeMap } from "../role-assignee-map.js";

describe("StaticRoleAssigneeMap (FR-9)", () => {
  it("resolves a known owner_role from an injected config", async () => {
    const map = new StaticRoleAssigneeMap({
      "Compliance Officer": { externalAssigneeRef: "queue:compliance-ops", displayLabel: "Compliance Officer" }
    });
    const resolved = await map.resolve("Compliance Officer");
    expect(resolved).toEqual({ externalAssigneeRef: "queue:compliance-ops", displayLabel: "Compliance Officer", isFallback: false });
  });

  it("returns null (not a thrown error) for an unmapped owner_role", async () => {
    const map = new StaticRoleAssigneeMap({});
    expect(await map.resolve("Some Unmapped Role")).toBeNull();
  });

  it("loads the checked-in default role-assignee-map.json when constructed with no config", async () => {
    const map = new StaticRoleAssigneeMap();
    const resolved = await map.resolve("Compliance Officer");
    expect(resolved).not.toBeNull();
    expect(resolved?.isFallback).toBe(false);
  });
});
