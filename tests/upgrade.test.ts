/**
 * Migrations 0003–0005 must upgrade a database that already has data under
 * the earlier schema (0001 + 0002), as the deployed Supabase database does,
 * and 0005 must convert the existing rows to the SRS v2 design.
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
  // Old rules: one payment per reservation, points = amount ÷ 50 credited at payment.
  // 1001 finished long ago but is still Booked; 1002 is a future stay; 1003 was cancelled.
  await pg.exec(`
    INSERT INTO bookinn.staff (staff_id, u_name, pass, name, role, is_active) VALUES
      (1001, 'KDPALVARADO', '${hash}', 'Keizzy', 'Front Desk', true),
      (1002, 'JESMEDEL', '${hash}', 'Jody', 'Finance', false);
    INSERT INTO bookinn.customer (cus_id, cus_name, cus_email, cus_mobile) VALUES (1001, 'JUAN', 'j@x.com', '09061234567');
    INSERT INTO bookinn.loyalty_acc (lyl_id, cus_id, total_pts) VALUES (5001, 1001, 300);
    INSERT INTO bookinn.room_details VALUES ('RT01', 'Standard', 1500, 'Ocean View');
    INSERT INTO bookinn.room VALUES (205, 'RT01'), (406, 'RT01');
    INSERT INTO bookinn.reservation (res_id, cus_id, booking_status) VALUES
      (1001, 1001, 'Booked'), (1002, 1001, 'Booked'), (1003, 1001, 'Cancelled');
    INSERT INTO bookinn.reservation_room (res_room_id, res_id, room_no, check_in_date, check_out_date) VALUES
      (10001, 1001, 205, '2020-01-01', '2020-01-03'),
      (10002, 1002, 205, '2099-01-01', '2099-01-05'),
      (10003, 1003, 406, '2020-02-01', '2020-02-02');
    INSERT INTO bookinn.payment (pay_id, res_id, pay_method, pay_date, pay_amt, pts_earn, pts_spend, discount_type) VALUES
      (1001, 1001, 'Cash', '2019-12-01', 3000, 60, 0, 'NONE'),
      (1002, 1002, 'Card', '2026-10-01', 6000, 120, 0, 'NONE'),
      (1003, 1003, 'Cash', '2020-01-15', 1500, 30, 0, 'NONE');
    INSERT INTO bookinn.receipt (rct_no, pay_id) VALUES (1001, 1001), (1002, 1002), (1003, 1003);
    INSERT INTO bookinn.cancellation (cancel_id, res_id, cancel_date, cancelled_by) VALUES (9001, 1003, '2020-01-20', 'Customer');
    INSERT INTO bookinn.audit_trail (staff_id, action, aff_tab, rec_id, old_data, new_data) VALUES (1001, 'INSERT', 'CANCELLATION', 9001, NULL, 'x');
  `);
});
afterAll(async () => {
  await pg.close();
  await rm(oldDir, { recursive: true, force: true });
});

describe("upgrading an existing database", () => {
  it("applies 0003–0005 and keeps the existing rows", async () => {
    expect(await migrate(db)).toEqual(["0003_srs_revision.sql", "0004_srs_v2_enums.sql", "0005_srs_v2_schema.sql"]);
    const staff = await db.query("SELECT staff_id, is_active::text FROM bookinn.staff ORDER BY 1");
    expect(staff.rows).toEqual([{ staff_id: 1001, is_active: "Yes" }, { staff_id: 1002, is_active: "No" }]);
    expect((await db.query("SELECT * FROM bookinn.cancellation")).rows).toEqual([{ cancel_id: 9001, res_id: 1003, cancel_date: "2020-01-20" }]);
    expect(await migrate(db)).toEqual([]); // idempotent
  });

  it("converts the rows to the SRS v2 design", async () => {
    // Finished stay still Booked → Completed (no No-Show email for old data); others unchanged.
    expect((await db.query("SELECT res_id, booking_status::text AS s FROM bookinn.reservation ORDER BY 1")).rows).toEqual([
      { res_id: 1001, s: "Completed" }, { res_id: 1002, s: "Booked" }, { res_id: 1003, s: "Cancelled" },
    ]);
    // Every existing payment is an Initial payment; the future stay's points are recalculated (÷ 100)
    // and taken back until it is Completed; finished and cancelled history is left alone.
    expect((await db.query("SELECT pay_id, pay_type::text AS t, pts_earn FROM bookinn.payment ORDER BY 1")).rows).toEqual([
      { pay_id: 1001, t: "Initial", pts_earn: 60 }, { pay_id: 1002, t: "Initial", pts_earn: 60 }, { pay_id: 1003, t: "Initial", pts_earn: 30 },
    ]);
    expect((await db.query("SELECT total_pts FROM bookinn.loyalty_acc WHERE lyl_id = 5001")).rows[0].total_pts).toBe(180); // 300 − 120
    // New columns are empty for old rows; the conversion is audited as a system action.
    expect((await db.query("SELECT count(*)::int AS n FROM bookinn.reservation_room WHERE actual_check_in IS NOT NULL")).rows[0].n).toBe(0);
    const audit = await db.query("SELECT staff_id, aff_tab::text, rec_id FROM bookinn.audit_trail WHERE aff_tab IN ('RESERVATION', 'LOYALTY_ACC', 'PAYMENT') ORDER BY audit_id");
    expect(audit.rows).toEqual([
      { staff_id: null, aff_tab: "RESERVATION", rec_id: "1001" },
      { staff_id: null, aff_tab: "LOYALTY_ACC", rec_id: "5001" },
      { staff_id: null, aff_tab: "PAYMENT", rec_id: "1002" },
    ]);
  });

  it("still accepts a Checkout payment and the new tables after the upgrade", async () => {
    await db.query("INSERT INTO bookinn.payment (pay_id, res_id, pay_type, pay_method, pay_date, pay_amt) VALUES (1004, 1002, 'Checkout', 'Cash', '2099-01-05', 0)");
    await db.query("INSERT INTO bookinn.adjustment_charge (res_id, charge_type, charge_amt) VALUES (1002, 'Modification', 1500)");
    await db.query("INSERT INTO bookinn.refund (res_id, refund_type, refund_amt, refund_date) VALUES (1003, 'Cancellation', 0, '2020-01-20')");
    expect((await db.query("SELECT min(charge_id) AS c FROM bookinn.adjustment_charge")).rows[0].c).toBe(7001);
  });
});
