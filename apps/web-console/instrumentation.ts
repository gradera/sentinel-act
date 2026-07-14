// Spec 15 §11 Task 11: Next.js's instrumentation hook — `register()` runs
// once, before this app starts serving any request, in every runtime
// Next.js boots (`next dev`, `next start`, and Vercel's own build/runtime
// pipeline all call this the same way). Restricted to the Node runtime
// (not edge) since validateWebConsoleEnv/zod have no reason to run twice
// per request across both runtimes for a startup-only check.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { validateWebConsoleEnv, WebConsoleEnvValidationError } = await import("./lib/console/env");
    try {
      validateWebConsoleEnv();
    } catch (err) {
      if (err instanceof WebConsoleEnvValidationError) {
        console.error(err.message);
        process.exit(1);
      }
      throw err;
    }
  }
}
