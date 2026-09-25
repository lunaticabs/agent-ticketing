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
 */
export async function register(): Promise<void> {
  // Skip the edge runtime: this banner reads the filesystem-backed config and is
  // only meaningful for the Node server.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { printStartupBanner } = await import('./lib/startup');
  printStartupBanner();
}
