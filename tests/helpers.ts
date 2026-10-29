import { PGlite, type Transaction } from "@electric-sql/pglite";
import { RAW_STRING_OIDS, type Db, type Row } from "@/lib/db/types";
import { migrate } from "@/lib/db/migrate";
import { seed } from "@/lib/db/seed";
import type { Actor } from "@/lib/audit";

const parsers = Object.fromEntries(Object.values(RAW_STRING_OIDS).map((oid) => [oid, (v: string) => v]));

function wrap(conn: PGlite | Transaction): Db {
  return {
    query: async <T extends Row>(sql: string, params?: unknown[]) =>
      ({ rows: (await conn.query<T>(sql, params)).rows }),
    exec: async (sql) => {
      await conn.exec(sql);
    },
    tx: async (fn) =>
      conn instanceof PGlite ? conn.transaction((t) => fn(wrap(t))) : fn(wrap(conn)), // nested → same tx
  };
}

export const PASSWORDS = { admin: "Admin#2026x", frontDesk: "Front#Desk2026", finance: "Finance#2026" };

/** Fresh in-memory Postgres with the real migrations and (optionally) the corrected seed data. */
export async function freshDb(withSeed = true) {
  const pg = await PGlite.create({ parsers });
  const db = wrap(pg);
  await migrate(db);
  if (withSeed) await seed(db, PASSWORDS, 4);
  return { db, close: () => pg.close() };
}

export const FRONT_DESK: Actor = { staffId: 1001, role: "Front Desk" };
export const FINANCE: Actor = { staffId: 1002, role: "Finance" };
export const ADMIN: Actor = { staffId: 1003, role: "Database Administrator" };

/** "Today" for tests, in the hotel time zone (after the seeded pay dates, before booking 1004). */
export const TODAY = "2026-11-01";

export async function auditFor(db: Db, table: string, recId: string | number) {
  const r = await db.query<{ action: string; old_data: string | null; new_data: string | null; staff_id: number | null }>(
    `SELECT action::text, old_data, new_data, staff_id FROM bookinn.audit_trail
      WHERE aff_tab = $1 AND rec_id = $2 ORDER BY audit_id`,
    [table, String(recId)],
  );
  return r.rows;
}

export async function count(db: Db, table: string, where = "true", params: unknown[] = []) {
  return Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM bookinn.${table} WHERE ${where}`, params)).rows[0].n);
}

export async function points(db: Db, lylId: number) {
  return Number((await db.query<{ p: number }>("SELECT total_pts AS p FROM bookinn.loyalty_acc WHERE lyl_id = $1", [lylId])).rows[0].p);
}
