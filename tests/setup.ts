/**
 * Test bootstrap. MUST be imported before anything that touches `lib/db`.
 *
 * ES modules evaluate their imports in declaration order, so a test file whose
 * first import is this one gets an isolated database before `lib/db` reads
 * `PRESENCE_DB` and caches a connection on `globalThis`.
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(process.cwd(), '.test-db');
fs.mkdirSync(dir, { recursive: true });

process.env.PRESENCE_DB = path.join(dir, `test-${process.pid}-${Date.now()}.db`);
process.env.PRESENCE_SIGNING_KEY =
  process.env.PRESENCE_SIGNING_KEY ?? 'presence-test-signing-key-0123456789abcdefghij';
// The dev routes are the disclosed demo bypass; tests exercise them directly,
// and one test asserts that they 404 when the flag is absent.
process.env.ENABLE_DEV_ROUTES = '1';
// Never let a test reach the real IdP: no credentials => local fallback.
delete process.env.WORLDID_CLIENT_ID;
delete process.env.WORLDID_CLIENT_SECRET;
process.env.PRESENCE_PUBLIC_URL = 'http://localhost:3000';

export const TEST_DB_PATH = process.env.PRESENCE_DB;
export { dir as TEST_DB_DIR };
