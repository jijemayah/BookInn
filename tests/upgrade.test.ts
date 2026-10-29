/**
 * Migration 0003 must upgrade a database that already has data under the
 * earlier schema (0001 + 0002), as the deployed Supabase database does.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { RAW_STRING_OIDS } from "@/lib/db/types";
import { migrate, MIGRATIONS_DIR } from "@/lib/db/migrate";
import type { Db } from "@/lib/db/types";

const parsers = Object.fromEntries(Object.values(RAW_STRING_OIDS).map((oid) => [oid, (v: string) => v]));
let pg: PGlite;
let db: Db;
let oldDir: string;

beforeAll(async () => {
  pg = await PGlite.create({ parsers });
  db = {
    query: async (sql, params) => ({ rows: (await pg.query(sql, params)).rows as never[] }),
    exec: async (sql) => void (await pg.exec(sql)),
    tx: (fn) => pg.transaction((t) => fn({ ...db, query: async (s, p) => ({ rows: (await t.query(s, p)).rows as never[] }), exec: async (s) => void (await t.exec(s)) })),
  };
  oldDir = await mkdtemp(path.join(tmpdir(), "bookinn-old-"));
  for (const f of ["0001_init_schema.sql", "0002_proposed_staff_is_active.sql"]) await copyFile(path.join(MIGRATIONS_DIR, f), path.join(oldDir, f));
  await migrate(db, oldDir);
  const hash = "$2b$04$" + "a".repeat(53);
  await pg.exec(`
    INSERT INTO bookinn.staff (staff_id, u_name, pass, name, role, is_active) VALUES
      (1001, 'KDPALVARADO', '${hash}', 'Keizzy', 'Front Desk', true),
      (1002, 'JESMEDEL', '${hash}', 'Jody', 'Finance', false);
    INSERT INTO bookinn.customer (cus_id, cus_name, cus_email, cus_mobile) VALUES (1001, 'JUAN', 'j@x.com', '09061234567');
    INSERT INTO bookinn.reservation (res_id, cus_id, booking_status) VALUES (1003, 1001, 'Cancelled');
    INSERT INTO bookinn.cancellation (cancel_id, res_id, cancel_date, cancelled_by) VALUES (9001, 1003, '2026-09-15', 'Customer');
    INSERT INTO bookinn.audit_trail (staff_id, action, aff_tab, rec_id, old_data, new_data) VALUES (1001, 'INSERT', 'CANCELLATION', 9001, NULL, 'x');
  `);
});
afterAll(async () => {
  await pg.close();
  await rm(oldDir, { recursive: true, force: true });
});

describe("upgrading an existing database", () => {
  it("applies 0003 and keeps the existing rows", async () => {
    expect(await migrate(db)).toEqual(["0003_srs_revision.sql"]);
    const staff = await db.query("SELECT staff_id, is_active::text FROM bookinn.staff ORDER BY 1");
    expect(staff.rows).toEqual([{ staff_id: 1001, is_active: "Yes" }, { staff_id: 1002, is_active: "No" }]);
    expect((await db.query("SELECT * FROM bookinn.cancellation")).rows).toEqual([{ cancel_id: 9001, res_id: 1003, cancel_date: "2026-09-15" }]);
    expect((await db.query("SELECT rec_id FROM bookinn.audit_trail")).rows).toEqual([{ rec_id: "9001" }]);
    expect(await migrate(db)).toEqual([]); // idempotent
  });
});
