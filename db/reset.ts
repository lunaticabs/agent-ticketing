/**
 * Delete the SQLite file. `npm run reset` chains this with `seed`.
 *
 * The database is disposable by design: consumption state, draw seeds and audit
 * rows all live in one file, so "reset the demo" is a file operation rather than
 * a migration.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dbPath } from '../lib/db';

function main(): void {
  const base = dbPath();
  let removed = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${base}${suffix}`;
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      removed += 1;
    }
  }
  console.log(`· removed ${removed} file(s) at ${path.dirname(base)}`);
}

main();
