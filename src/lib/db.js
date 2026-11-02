import pg from 'pg';
import { envInt, log } from './common.js';

// NUMERIC (harga) dikembalikan sebagai number, bukan string.
pg.types.setTypeParser(1700, (v) => Number.parseFloat(v));

export function createPool(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL belum diatur');
  const pool = new pg.Pool({
    connectionString,
    max: envInt('PG_POOL_MAX', 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  pool.on('error', (e) => log('error', 'pg pool error', { error: e.message }));
  return pool;
}

export async function waitForDb(pool, retries = 30, delayMs = 2000) {
  for (let i = 1; i <= retries; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (e) {
      log('warn', `database belum siap (${i}/${retries})`, { error: e.message });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('Database tidak dapat dihubungi');
}

export async function withTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Migrasi idempoten yang aman dijalankan bersamaan oleh banyak replika:
 * advisory lock level transaksi (kompatibel dengan connection pooler Neon).
 */
export async function migrate(pool, lockId, fn) {
  await withTx(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [lockId]);
    await fn(c);
  });
}
