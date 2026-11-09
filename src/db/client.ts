import pg from 'pg';
export interface Sql {
  query<T extends pg.QueryResultRow = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}
export interface Database extends Sql {
  transaction<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export function postgres(url: string): Database {
  if (!url.trim()) {
    throw new Error(
      'DATABASE_URL is missing. Configure .env and run npm run migrate from the backend folder.',
    );
  }
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  return {
    query: <T extends pg.QueryResultRow>(sql: string, values?: unknown[]) =>
      pool.query<T>(sql, values),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          query: <T extends pg.QueryResultRow>(s: string, v?: unknown[]) =>
            client.query<T>(s, v),
        });
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
