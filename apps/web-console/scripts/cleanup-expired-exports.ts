// Spec 10 §11 Task 11 / FR-16 — scheduled cleanup for expired Compliance
// Register Export jobs and their generated files.
//
// ***** What this does *****
// 1. Opens the shared Neo4j driver (`getDriver()`, same singleton every
//    route handler in this app uses).
// 2. Calls `ExportJobStore.deleteExpired()` (packages/graph-db/src/queries/
//    export-job-store.ts), which deletes every `:ExportJob` node whose
//    `expiresAt` (`requestedAt` + 7 days default, FR-16) has passed, and
//    returns the `filePath` each deleted job pointed at (possibly `null`
//    for a job that never completed, e.g. an expired `queued`/`failed`
//    job with no generated file).
// 3. For every non-null `filePath`, deletes the actual file from local
//    disk via `deleteExportFile` (apps/web-console/lib/console/
//    export-storage.ts) — the file lives under
//    `os.tmpdir()/sentinel-act-exports/<exportId>.<format>`
//    (export-storage.ts's `EXPORTS_DIR` constant), NOT anywhere under the
//    git-tracked repo checkout.
//
// ***** Why file deletion actually works here, unlike elsewhere in this
// sandbox *****
// This session's repo mount (`/sessions/.../mnt/sentinel-act`) returns
// EPERM on `unlink` for any file under the checked-out working tree — a
// restriction of THIS SANDBOX's mounted-repo filesystem, confirmed
// repeatedly across earlier stages (see this repo's other "no file
// deletion" notes). That restriction is specific to the mounted git
// working tree. `os.tmpdir()` (e.g. `/tmp`, or this sandbox's
// `$TMPDIR`) is a completely different filesystem/mount with normal
// read-write-delete permissions — verified directly before writing this
// script:
//
//   node -e "const fs=require('node:fs/promises'); (async () => {
//     const f = '/tmp/sentinel-act-exports/delete-test.txt';
//     await fs.mkdir(require('node:path').dirname(f), {recursive:true});
//     await fs.writeFile(f, 'hello');
//     await fs.unlink(f); // succeeds — no EPERM
//   })();"
//
// So this script's file-deletion step is NOT blocked by the repo-mount
// restriction; it operates purely on `EXPORTS_DIR`, which is always
// outside the repo checkout by construction (see export-storage.ts's own
// top-of-file comment on why `os.tmpdir()` was chosen over a repo-relative
// `tmp/` directory).
//
// ***** How to run this locally *****
// `tsx` is NOT resolvable from `apps/web-console` in this sandbox — only
// `packages/graph-db` declares it as a devDependency (verified: there is
// no `apps/web-console/node_modules/.bin/tsx`, and no root-level
// `node_modules/.bin/tsx` either; `pnpm install` cannot run here to add
// one). The working invocation, from the repo root, borrows
// `packages/graph-db`'s already-installed `tsx` binary to run a script
// that lives under `apps/web-console` (module resolution for this file's
// own imports still follows normal Node resolution from this file's own
// location, so `@sentinel-act/graph-db` / relative imports below resolve
// via `apps/web-console/node_modules` exactly as they would under
// `next dev`):
//
//   ./packages/graph-db/node_modules/.bin/tsx apps/web-console/scripts/cleanup-expired-exports.ts
//
// In a real dev machine / CI environment where `pnpm install` has been
// run for the whole workspace (so `tsx` is resolvable the normal way),
// the equivalent is:
//
//   pnpm --filter @sentinel-act/web-console exec tsx scripts/cleanup-expired-exports.ts
//
// Requires the same environment variables every other script in this repo
// that touches Neo4j needs (`NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`,
// etc. — see packages/graph-db/src/driver.ts), e.g. via
// `--env-file=.env`, mirroring packages/graph-db/seed/seed.ts's own
// invocation convention (`tsx --env-file=.env seed/seed.ts`).
//
// ***** Deliberate, spec-acknowledged deferral (§13 Open Question 9) *****
// This is a manual/cron-invocable SCRIPT, not a scheduler. Spec 10 §11
// Task 11 explicitly says: "implementation vehicle depends on the
// deployment target ... stub as a locally-runnable script plus a
// documented deployment TODO if the target isn't settled yet." A real
// deployment needs this wired to an actual scheduled trigger appropriate
// to its hosting target — a Vercel Cron Job (`vercel.json` `crons` entry
// hitting a protected internal API route that calls
// `cleanupExpiredExports()`), a Kubernetes `CronJob` running this file via
// `tsx`/a compiled build, a plain host crontab entry, etc. Which of those
// applies is not decided by this spec (§13 Open Question 2 notes the same
// undecided-hosting-target problem for export file storage itself) — this
// is a documented gap, not something to solve further in this unit.
import { closeDriver, ExportJobStore, getDriver } from "@sentinel-act/graph-db";
import { deleteExportFile } from "../lib/console/export-storage.js";

export interface CleanupExpiredExportsResult {
  deletedJobs: number;
  deletedFiles: number;
  fileDeleteErrors: number;
}

/** The unit of work a scheduler (cron/Vercel Cron/k8s CronJob/manual run)
 *  invokes. Exported separately from the `main()`-style guard below so a
 *  test can call it directly against injected fakes without going through
 *  a real Neo4j connection or real disk I/O — see this file's
 *  `cleanup-expired-exports.test.ts` sibling for exactly that. */
export async function cleanupExpiredExports(
  store: Pick<ExportJobStore, "deleteExpired">,
  deleteFile: (filePath: string) => Promise<void> = deleteExportFile
): Promise<CleanupExpiredExportsResult> {
  const { deletedCount, filePaths } = await store.deleteExpired();

  let deletedFiles = 0;
  let fileDeleteErrors = 0;
  for (const filePath of filePaths) {
    if (filePath === null) {
      // Expired job that never completed (queued/failed) — no file was
      // ever written for it (ComplianceRegisterExportJob.filePath doc
      // comment: "set once generation completes").
      continue;
    }
    try {
      await deleteFile(filePath);
      deletedFiles++;
    } catch (error) {
      fileDeleteErrors++;
      console.error(`cleanup-expired-exports: failed to delete file ${filePath}:`, error);
    }
  }

  return { deletedJobs: deletedCount, deletedFiles, fileDeleteErrors };
}

/** Real entrypoint: opens a real driver, runs the cleanup, closes the
 *  driver, and exits with a non-zero code on failure (so a cron wrapper /
 *  CI job can detect a failed run). Guarded so importing this module (as
 *  the unit test does, for `cleanupExpiredExports` above) never triggers a
 *  real Neo4j connection as a side effect of the import itself. */
async function main(): Promise<void> {
  const driver = getDriver();
  const store = new ExportJobStore(driver);
  try {
    const result = await cleanupExpiredExports(store);
    console.log(
      `cleanup-expired-exports: deleted ${result.deletedJobs} expired job(s), ` +
        `${result.deletedFiles} file(s)` +
        (result.fileDeleteErrors > 0 ? `, ${result.fileDeleteErrors} file delete error(s)` : "") +
        "."
    );
  } finally {
    await closeDriver();
  }
}

const isDirectRun = typeof process.argv[1] === "string" && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error("cleanup-expired-exports: run failed", error);
      process.exit(1);
    });
}
