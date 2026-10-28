import { Pool, types, type PoolClient, type PoolConfig } from "pg";
import { RAW_STRING_OIDS, type Db, type Row } from "./types";

for (const oid of Object.values(RAW_STRING_OIDS)) {
  types.setTypeParser(oid, (v: string) => v);
}

/**
 * Connection settings come from env only (never source control):
 *   DATABASE_URL                                  — full connection string, or
 *   SUPABASE_DB_HOST/PORT/NAME/USER/PASSWORD/SSLMODE — same vars as the legacy PHP app.
 * On Vercel use Supabase's *transaction pooler* (port 6543, user postgres.<ref>).
 */
export function poolConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const sslmode = (env.SUPABASE_DB_SSLMODE ?? "require").toLowerCase();
  // sslmode=require → encrypted, matching libpq semantics. Provide SUPABASE_DB_CA
  // (PEM of Supabase's root cert) to additionally verify the server certificate.
  const ssl =
    sslmode === "disable"
      ? false
      : env.SUPABASE_DB_CA
        ? { ca: env.SUPABASE_DB_CA, rejectUnauthorized: true }
        : { rejectUnauthorized: false };

  const base: PoolConfig = {
    ssl,
    max: Number(env.DB_POOL_MAX ?? 3), // small: serverless functions each get their own pool
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  };
  if (env.DATABASE_URL) return { ...base, connectionString: env.DATABASE_URL };
  if (!env.SUPABASE_DB_HOST || !env.SUPABASE_DB_PASSWORD) {
    throw new Error("Database not configured: set DATABASE_URL or SUPABASE_DB_HOST/SUPABASE_DB_PASSWORD.");
  }
  return {
    ...base,
    host: env.SUPABASE_DB_HOST,
    port: Number(env.SUPABASE_DB_PORT ?? 5432),
    database: env.SUPABASE_DB_NAME ?? "postgres",
    user: env.SUPABASE_DB_USER ?? "postgres",
    password: env.SUPABASE_DB_PASSWORD,
  };
}

function clientDb(client: PoolClient): Db {
  return {
    query: async <T extends Row>(sql: string, params?: unknown[]) =>
      ({ rows: (await client.query(sql, params)).rows as T[] }),
    exec: async (sql) => {
      await client.query(sql);
    },
    tx: async (fn) => fn(clientDb(client)), // already inside a transaction
  };
}

export function createPgDb(pool: Pool): Db {
  return {
    query: async <T extends Row>(sql: string, params?: unknown[]) =>
      ({ rows: (await pool.query(sql, params)).rows as T[] }),
    exec: async (sql) => {
      await pool.query(sql);
    },
    tx: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(clientDb(client));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

// Reuse one pool per server instance (and across dev hot reloads).
const g = globalThis as unknown as { __bookinnDb?: { pool: Pool; db: Db } };

export function getDb(): Db {
  if (!g.__bookinnDb) {
    const pool = new Pool(poolConfigFromEnv());
    g.__bookinnDb = { pool, db: createPgDb(pool) };
  }
  return g.__bookinnDb.db;
}

export async function closeDb(): Promise<void> {
  if (g.__bookinnDb) {
    await g.__bookinnDb.pool.end();
    g.__bookinnDb = undefined;
  }
}
