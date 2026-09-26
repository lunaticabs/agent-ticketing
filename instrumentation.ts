/**
 * Runs once when the server process starts, before the first request.
 *
 * The startup banner used to be lazy: it printed the first time one of a few
 * routes was hit. That is fine for an informational banner and wrong for a
 * consistency warning — a misconfiguration should be visible the moment the
 * server comes up, not the first time somebody happens to load the board.
 *
 * The banner itself is idempotent (guarded by a module-level flag), so the lazy
 * call sites can stay as a belt-and-braces fallback for any runtime that does
 * not run this hook.
 *
 * ── What is deliberately NOT here ─────────────────────────────────────────
 *
 * Seeding the demo event. It belongs on this path — a container on a fresh
 * volume should come up working — but not in *this file*, because Next compiles
 * `instrumentation.ts` for the Edge runtime as well as the Node one, and webpack
 * traces a dynamic `import()` into the Edge bundle regardless of the runtime
 * guard around it. Importing `lib/demo` (which reaches `better-sqlite3` through
 * `lib/db`) therefore fails the whole app with `Module not found: Can't resolve
 * 'fs'` — for every request, not just the banner. It happened twice while this
 * was being written, once through a static import and once through a dynamic
 * one. `lib/startup.ts` is already database-touching and already dynamic, so the
 * seeding lives there instead: one edge to guard rather than two.
 */
export async function register(): Promise<void> {
  // Skip the edge runtime: the banner reads the filesystem-backed database and is
  // only meaningful for the Node server.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { printStartupBanner } = await import('./lib/startup');
  printStartupBanner();
}
