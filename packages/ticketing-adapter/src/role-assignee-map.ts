// FR-9: RoleAssigneeMapPort's recommended default implementation — a
// static, checked-in JSON config file mapping known ProcessTask.owner_role
// strings to { externalAssigneeRef, displayLabel }, loaded once at process
// startup. §13 item 1: NO real roster/directory/HR data source exists
// anywhere in this repo; this is an explicit, flagged placeholder, not a
// pretend-real answer. Structured so it can be swapped for a real
// roster-backed implementation later without changing the port's shape or
// any caller (FR-9).
//
// Read via fs (not a native ESM JSON import) so this package does not
// depend on `resolveJsonModule`/import-attribute support in every
// downstream consumer's TS/Node version — same defensive posture as
// migrations/runner.ts's __dirname-relative file read.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RoleAssigneeMapPort, TicketAssignee } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_ROLE_ASSIGNEE_MAP_PATH = path.join(__dirname, "role-assignee-map.json");

export type RoleAssigneeMapConfig = Record<string, { externalAssigneeRef: string; displayLabel: string }>;

function loadConfig(filePath: string): RoleAssigneeMapConfig {
  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as RoleAssigneeMapConfig;
}

/** Static, checked-in-JSON-backed RoleAssigneeMapPort. `resolve()` never
 *  throws — an owner_role with no entry (the expected common case in this
 *  build, §4.2) simply returns null, and FR-8's fallback wiring
 *  (resolveAssignee in mapping.ts) takes it from there. */
export class StaticRoleAssigneeMap implements RoleAssigneeMapPort {
  private readonly config: RoleAssigneeMapConfig;

  constructor(config?: RoleAssigneeMapConfig) {
    this.config = config ?? loadConfig(DEFAULT_ROLE_ASSIGNEE_MAP_PATH);
  }

  async resolve(owner_role: string): Promise<TicketAssignee | null> {
    const entry = this.config[owner_role];
    if (!entry) {
      return null;
    }
    return { externalAssigneeRef: entry.externalAssigneeRef, displayLabel: entry.displayLabel, isFallback: false };
  }
}

/** Convenience factory reading the checked-in default config file. */
export function createStaticRoleAssigneeMap(filePath: string = DEFAULT_ROLE_ASSIGNEE_MAP_PATH): StaticRoleAssigneeMap {
  return new StaticRoleAssigneeMap(loadConfig(filePath));
}
