import { PGlite } from '@electric-sql/pglite';
import { config } from '../src/config.js';
import type { Database, Sql } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { postgres } from '../src/db/client.js';
import { randomUUID } from 'node:crypto';
export const testConfig = () =>
  config({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://unused',
    EMAIL_WEBHOOK_SECRET: 'test-webhook-secret-32-characters-long',
    DATA_KEYS: JSON.stringify({ v1: 'ab'.repeat(32) }),
    SUPPRESSION_HASH_KEY: 'test-suppression-key-32-characters-long',
    LOG_LEVEL: 'silent',
    RATE_LIMIT_MAX: '1000',
  });
export async function memoryDb(): Promise<Database> {
  if (process.env.TEST_DATABASE_URL) {
    const url = new URL(process.env.TEST_DATABASE_URL),
      admin = postgres(url.toString());
    const schema = 'test_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const db = postgres(url.toString());
    await migrate(db);
    return {
      ...db,
      async close() {
        await db.close();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.close();
      },
    };
  }
  const pg = new PGlite();
  const wrap = (client: Pick<PGlite, 'query' | 'exec'>): Sql => ({
    async query<T>(sql: string, values?: unknown[]) {
      if (!values && sql.includes(';')) {
        await client.exec(sql);
        return { rows: [] as T[], rowCount: 0 };
      }
      const r = await client.query<T>(sql, values);
      return { rows: r.rows, rowCount: r.affectedRows ?? 0 };
    },
  });
  const db: Database = {
    ...wrap(pg),
    transaction: (fn) => pg.transaction((tx) => fn(wrap(tx))),
    close: () => pg.close(),
  };
  await migrate(db);
  return db;
}
export const signup = {
  email: 'person@example.com',
  interests: ['password_manager'],
  consent: true,
  consentVersion: 'development-marketing-v1',
  source: 'homepage',
  website: '',
};
