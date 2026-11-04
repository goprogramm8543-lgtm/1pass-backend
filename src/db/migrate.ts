import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { postgres, type Database } from './client.js';
import { digest } from '../common/security.js';
export async function migrate(db: Database) {
  await db.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  await db.transaction(async (tx) => {
    await tx.query('LOCK TABLE schema_migrations IN EXCLUSIVE MODE');
    for (const file of (await readdir('migrations'))
      .filter((f) => f.endsWith('.sql'))
      .sort()) {
      const sql = (await readFile(`migrations/${file}`, 'utf8')).replace(
        /\r\n/g,
        '\n',
      );
      const old = (
        await tx.query<{ checksum: string }>(
          'SELECT checksum FROM schema_migrations WHERE name=$1',
          [file],
        )
      ).rows[0];
      if (old) {
        if (old.checksum !== digest(sql))
          throw new Error('Applied migration checksum changed');
        continue;
      }
      await tx.query(sql);
      await tx.query(
        'INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',
        [file, digest(sql)],
      );
    }
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const db = postgres(process.env.DATABASE_URL ?? '');
  try {
    await migrate(db);
    console.log('Migrations applied');
  } finally {
    await db.close();
  }
}
