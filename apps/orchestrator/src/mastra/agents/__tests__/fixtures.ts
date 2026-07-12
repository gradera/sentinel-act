// Shared fixture-loading helper for regulatory-watch.*.test.ts (Spec 02
// §10). Not itself a test file (vitest only picks up files matching its
// test-file glob), just a small utility every test file in this
// directory imports.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "__fixtures__");

export function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}
