import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

export async function one<T extends pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T> {
  const res = await pool.query<T>(text, params);
  if (res.rowCount !== 1) throw new Error(`Expected 1 row, got ${res.rowCount}`);
  return res.rows[0];
}

export async function maybeOne<T extends pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T | null> {
  const res = await pool.query<T>(text, params);
  return res.rows[0] ?? null;
}

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
