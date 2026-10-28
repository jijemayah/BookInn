/**
 * Minimal database abstraction shared by the app (node-postgres → Supabase)
 * and the tests (PGlite, an in-process Postgres). All business logic is
 * written against this interface so it is exercised identically in both.
 */
export type Row = Record<string, unknown>;

export interface Db {
  /** Parameterized query ($1, $2, …). Values are never interpolated. */
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Run a multi-statement script (migrations only — no parameters). */
  exec(sql: string): Promise<void>;
  /** Run fn inside a single transaction; rolls back if it throws. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

/** Postgres type OIDs we want returned as raw strings, not JS objects. */
export const RAW_STRING_OIDS = {
  DATE: 1082, // keep 'YYYY-MM-DD' (no timezone shifting)
  TIMESTAMP: 1114,
  TIMESTAMPTZ: 1184,
  NUMERIC: 1700, // keep exact decimal(8,2) text, avoid float rounding
} as const;
