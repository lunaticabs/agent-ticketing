/**
 * SQLite connection + schema bootstrap.
 *
 * A single file-backed database, opened synchronously. `better-sqlite3`'s
 * synchronous API is a feature here, not a limitation: every read-modify-write
 * in this project (draw a lottery, consume a proof, defer a slot) runs inside
 * one synchronous transaction, so there is no interleaving to reason about.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type DB = Database.Database;

const SCHEMA_PATH = path.join(process.cwd(), 'db', 'schema.sql');

export function dbPath(): string {
  return process.env.PRESENCE_DB
    ? path.resolve(process.env.PRESENCE_DB)
    : path.join(process.cwd(), 'db', 'presence.db');
}

function open(): DB {
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Wait rather than fail when another connection (agent process, sweeper) is
  // mid-write. The demo runs several processes against one file.
  db.pragma('busy_timeout = 5000');
  if (fs.existsSync(SCHEMA_PATH)) {
    db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  }
  return db;
}

// Next.js dev mode re-evaluates modules on every hot reload. Cache the handle
// on globalThis so we do not leak a file descriptor per edit.
const globalForDb = globalThis as unknown as { __presenceDb?: DB };

export function getDb(): DB {
  if (!globalForDb.__presenceDb) globalForDb.__presenceDb = open();
  return globalForDb.__presenceDb;
}

/** Re-open from scratch. Used by `db/reset.ts` and the dev reset route. */
export function closeDb(): void {
  if (globalForDb.__presenceDb) {
    globalForDb.__presenceDb.close();
    globalForDb.__presenceDb = undefined;
  }
}

/**
 * Run `fn` inside a single synchronous transaction.
 *
 * Used for every state transition that must be all-or-nothing: deferral,
 * proof consumption, transfer completion. `IMMEDIATE` takes the write lock up
 * front so two concurrent requests cannot both read "PENDING" and both proceed.
 */
export function tx<T>(fn: (db: DB) => T): T {
  const db = getDb();
  const wrapped = db.transaction(fn);
  return wrapped(db) as T;
}

// ── Row helpers ─────────────────────────────────────────────────────────────

export function one<T>(sql: string, ...params: unknown[]): T | undefined {
  return getDb().prepare(sql).get(...params) as T | undefined;
}

export function all<T>(sql: string, ...params: unknown[]): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}

export function run(sql: string, ...params: unknown[]) {
  return getDb().prepare(sql).run(...params);
}

export function nowMs(): number {
  return Date.now();
}
