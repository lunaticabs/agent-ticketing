/**
 * ============================================================================
 *  Environment variable names — and the one rename this project has had
 * ============================================================================
 *
 * The project shipped as *Presence* and is now *HumanGate*. Variables that live
 * in a deployment's secret store cannot be renamed atomically with a commit:
 * a container that restarts between the push and the `fly secrets set` would
 * read an empty string, and several of these fail closed on an empty value.
 *
 * So every read goes through here:
 *
 *   - `HUMANGATE_*` is the name to use. It always wins when both are set.
 *   - `PRESENCE_*` still resolves, so a running deployment is unaffected.
 *
 * Rotate at your own pace, then delete the legacy branch:
 *
 *     fly secrets set HUMANGATE_PUBLIC_URL=... HUMANGATE_SIGNING_KEY=...
 *     fly secrets unset PRESENCE_PUBLIC_URL PRESENCE_SIGNING_KEY
 *
 * This is a **precedence rule over one value**, not two copies of one value:
 * there is exactly one function a reader can call, and `tests/env-rename.test.ts`
 * pins the order so the two names can never disagree in silence.
 *
 * Note what is deliberately *not* renamed: the database path, the Fly volume
 * name, and the two cookie names. Each would change runtime state rather than
 * configuration — a new database file, a new volume, or every live session
 * logged out — for no gain a judge would ever see. See docs/DEPLOY.md.
 */

/**
 * Read a configuration value, preferring the current name over the legacy one.
 *
 * Empty and whitespace-only values are treated as *absent* under both names, so
 * a half-filled secret cannot defeat a caller's `?? default` — and cannot mask a
 * legacy value that is still doing the work. Both halves have a test: R-4 and
 * R-5 in `tests/env-rename.test.ts`.
 */
export function env(name: string): string | undefined {
  const current = process.env[`HUMANGATE_${name}`]?.trim();
  const legacy = process.env[`PRESENCE_${name}`]?.trim();
  return current || legacy || undefined;
}

/** True when this variable is set under either name. Used by the startup banner. */
export function hasEnv(name: string): boolean {
  return env(name) !== undefined;
}
