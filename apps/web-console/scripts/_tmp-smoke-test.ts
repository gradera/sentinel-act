// This file was a throwaway smoke test (confirming `tsx` invoked from
// packages/graph-db/node_modules/.bin can resolve `@sentinel-act/graph-db`
// from a script living under apps/web-console/scripts/) written during
// Spec 10's final cleanup-script stage. It could not be deleted afterward
// because this sandbox's mounted-repo filesystem returns EPERM on
// `unlink` for any file under the git working tree (a known, pre-existing
// sandbox restriction — unrelated to this script's own subject matter,
// which is the cleanup script in the sibling file
// cleanup-expired-exports.ts). Left empty/inert rather than deleted;
// not imported or referenced by anything.
export {};
