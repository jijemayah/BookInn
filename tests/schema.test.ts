/** Schema shape (SRS v2 §4.3 / §4.4), seed data (Tables 7–19), RLS and audit-trail integrity. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/types";
import { listRows } from "@/lib/crud";
import { ADMIN, count, freshDb, points } from "./helpers";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await freshDb()));
afterAll(() => close());

const cols = async (t: string) =>
  (
    await db.query<{ column_name: string; data_type: string; is_nullable: string; udt_name: string }>(
      `SELECT column_name, data_type, is_nullable, udt_name FROM information_schema.columns
        WHERE table_schema = 'bookinn' AND table_name = $1 ORDER BY ordinal_position`,
      [t],
    )
  ).rows;

const enumValues = async (type: string) =>
  (
    await db.query<{ v: string }>(
      `SELECT e.enumlabel AS v FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'bookinn' AND t.typname = $1 ORDER BY e.enumsortorder`,
      [type],
    )
  ).rows.map((r) => r.v);

describe("schema (SRS v2 §4.3 / §4.4)", () => {
  it("creates exactly the 13 SRS tables in schema bookinn", async () => {
    const r = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'bookinn' AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations' ORDER BY 1`,
    );
    expect(r.rows.map((x) => x.table_name)).toEqual([
      "adjustment_charge", "audit_trail", "cancellation", "customer", "loyalty_acc", "payment", "receipt",
      "refund", "reservation", "reservation_room", "room", "room_details", "staff",
    ]);
  });

  it("matches the data dictionary columns of the changed and new tables", async () => {
    expect((await cols("payment")).map((c) => c.column_name)).toEqual([
      "pay_id", "res_id", "pay_method", "pay_date", "pay_amt", "pts_earn", "pts_spend", "discount_type", "pay_type",
    ]);
    expect((await cols("reservation_room")).map((c) => [c.column_name, c.data_type])).toEqual([
      ["res_room_id", "integer"], ["res_id", "integer"], ["room_no", "integer"],
      ["check_in_date", "date"], ["check_out_date", "date"],
      ["actual_check_in", "timestamp without time zone"], ["actual_check_out", "timestamp without time zone"],
    ]);
    expect((await cols("adjustment_charge")).map((c) => [c.column_name, c.is_nullable])).toEqual([
      ["charge_id", "NO"], ["res_id", "NO"], ["res_room_id", "YES"], ["charge_type", "NO"], ["ext_from", "YES"],
      ["ext_to", "YES"], ["charge_amt", "NO"], ["pay_status", "NO"], ["pay_id", "YES"],
    ]);
    expect((await cols("refund")).map((c) => c.column_name)).toEqual(["refund_id", "res_id", "refund_type", "refund_amt", "refund_date"]);
    expect((await cols("staff")).map((c) => c.column_name).sort()).toEqual(["is_active", "name", "pass", "role", "staff_id", "u_name"]);
    expect((await cols("cancellation")).map((c) => c.column_name)).toEqual(["cancel_id", "res_id", "cancel_date"]);
    // No stored price and no room status anywhere (§3.3 Setup Requirements, Room Availability).
    expect((await cols("reservation_room")).some((c) => c.column_name.includes("price"))).toBe(false);
    expect((await cols("room")).map((c) => c.column_name)).toEqual(["room_no", "room_type_id"]);
  });

  it("has the SRS enum values", async () => {
    expect(await enumValues("booking_status_t")).toEqual(["Booked", "Checked-In", "Completed", "Cancelled", "No-Show"]);
    expect(await enumValues("pay_type_t")).toEqual(["Initial", "Checkout"]);
    expect(await enumValues("charge_type_t")).toEqual(["Extension", "Modification"]);
    expect(await enumValues("charge_pay_status_t")).toEqual(["Unpaid", "Paid", "Voided"]);
    expect(await enumValues("refund_type_t")).toEqual(["Cancellation", "Checkout Credit"]);
    expect(await enumValues("aff_tab_t")).toEqual(expect.arrayContaining(["ADJUSTMENT_CHARGE", "REFUND"]));
    expect(await enumValues("aff_tab_t")).toHaveLength(12);
  });

  it("enforces the one-per-record rules", async () => {
    const r = await db.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'bookinn' AND i.indisunique ORDER BY 1`,
    );
    expect(r.rows.map((x) => x.name)).toEqual(
      expect.arrayContaining([
        "cancellation_res_uq", "customer_email_uq", "loyalty_acc_cus_uq", "receipt_pay_uq", "staff_u_name_uq",
        "payment_initial_uq", "payment_checkout_uq", "refund_cancellation_uq",
      ]),
    );
    expect(r.rows.map((x) => x.name)).not.toContain("payment_res_uq"); // RES_ID no longer unique on PAYMENT
  });

  it("uses the delete rules of Table 20", async () => {
    const r = await db.query<{ tab: string; col: string; rule: string }>(
      `SELECT cl.relname AS tab, a.attname AS col, c.confdeltype AS rule
         FROM pg_constraint c
         JOIN pg_class cl ON cl.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = cl.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE n.nspname = 'bookinn' AND c.contype = 'f' ORDER BY 1, 2`,
    );
    const rules = Object.fromEntries(r.rows.map((x) => [`${x.tab}.${x.col}`, x.rule]));
    expect(rules).toEqual({
      "adjustment_charge.pay_id": "n",
      "adjustment_charge.res_id": "c",
      "adjustment_charge.res_room_id": "n",
      "audit_trail.staff_id": "r",
      "cancellation.res_id": "c",
      "loyalty_acc.cus_id": "r",
      "payment.res_id": "c",
      "receipt.pay_id": "c",
      "refund.res_id": "c",
      "reservation.cus_id": "r",
      "reservation_room.res_id": "c",
      "reservation_room.room_no": "r",
      "room.room_type_id": "r",
    });
  });

  it("enables Row Level Security on every table and creates the overdue view", async () => {
    const r = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'bookinn' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'`,
    );
    expect(r.rows).toHaveLength(13);
    expect(r.rows.every((x) => x.relrowsecurity)).toBe(true);
    const v = await db.query("SELECT 1 FROM information_schema.views WHERE table_schema = 'bookinn' AND table_name = 'overdue_reservation'");
    expect(v.rows).toHaveLength(1);
  });

  it("rejects negative amounts and points, allows a ₱0 room type", async () => {
    await expect(db.query("UPDATE bookinn.loyalty_acc SET total_pts = -1 WHERE lyl_id = 5001")).rejects.toMatchObject({ code: "23514" });
    await expect(db.query("UPDATE bookinn.payment SET pay_amt = -1 WHERE pay_id = 1001")).rejects.toMatchObject({ code: "23514" });
    await expect(db.query("UPDATE bookinn.refund SET refund_amt = -1 WHERE refund_id = 8001")).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.query("INSERT INTO bookinn.room_details VALUES ('RT98', 'Standard', -1, 'City View')"),
    ).rejects.toMatchObject({ code: "23514", constraint: "room_details_price_chk" });
    await db.query("INSERT INTO bookinn.room_details VALUES ('RT99', 'Standard', 0, 'City View')");
    await db.query("DELETE FROM bookinn.room_details WHERE room_type_id = 'RT99'");
  });
});

describe("seed data (SRS v2 Tables 7–19)", () => {
  const rows = async (sql: string) => (await db.query(sql)).rows;

  it("loads Tables 7–17 as written, plus demo reservation 1004", async () => {
    expect(await count(db, "customer")).toBe(2);
    expect(await count(db, "room")).toBe(4);
    expect(await points(db, 5001)).toBe(75); // 60 + 15
    expect(await points(db, 5002)).toBe(250);
    expect(await rows("SELECT res_id, cus_id, booking_status::text FROM bookinn.reservation ORDER BY 1")).toEqual([
      { res_id: 1001, cus_id: 1001, booking_status: "Completed" },
      { res_id: 1002, cus_id: 1002, booking_status: "Booked" },
      { res_id: 1003, cus_id: 1001, booking_status: "Cancelled" },
      { res_id: 1004, cus_id: 1001, booking_status: "Booked" },
    ]);
    expect(
      await rows(
        `SELECT res_room_id, res_id, room_no, check_in_date, check_out_date,
                to_char(actual_check_in, 'YYYY-MM-DD HH24:MI') AS ain, to_char(actual_check_out, 'YYYY-MM-DD HH24:MI') AS aout
           FROM bookinn.reservation_room ORDER BY 1`,
      ),
    ).toEqual([
      { res_room_id: 10001, res_id: 1001, room_no: 205, check_in_date: "2026-06-25", check_out_date: "2026-06-28", ain: "2026-06-25 14:10", aout: "2026-06-28 11:40" },
      { res_room_id: 10002, res_id: 1001, room_no: 206, check_in_date: "2026-06-25", check_out_date: "2026-06-27", ain: "2026-06-25 14:10", aout: "2026-06-27 11:30" },
      { res_room_id: 10003, res_id: 1002, room_no: 108, check_in_date: "2026-10-08", check_out_date: "2026-10-11", ain: null, aout: null },
      { res_room_id: 10004, res_id: 1003, room_no: 406, check_in_date: "2026-09-25", check_out_date: "2026-09-29", ain: null, aout: null },
      { res_room_id: 10005, res_id: 1004, room_no: 206, check_in_date: "2026-12-20", check_out_date: "2026-12-22", ain: null, aout: null },
    ]);
    expect(
      await rows("SELECT pay_id, res_id, pay_type::text, pay_method::text, pay_date, pay_amt, pts_earn, pts_spend, discount_type::text FROM bookinn.payment ORDER BY 1"),
    ).toEqual([
      { pay_id: 1001, res_id: 1001, pay_type: "Initial", pay_method: "Digital Wallet", pay_date: "2026-06-20", pay_amt: "6000.00", pts_earn: 60, pts_spend: 0, discount_type: "NONE" },
      { pay_id: 1002, res_id: 1002, pay_type: "Initial", pay_method: "Cash", pay_date: "2026-08-07", pay_amt: "5280.00", pts_earn: 0, pts_spend: 100, discount_type: "12% Discount" },
      { pay_id: 1003, res_id: 1003, pay_type: "Initial", pay_method: "Digital Wallet", pay_date: "2026-09-11", pay_amt: "6000.00", pts_earn: 60, pts_spend: 0, discount_type: "NONE" },
      { pay_id: 1004, res_id: 1001, pay_type: "Checkout", pay_method: "Cash", pay_date: "2026-06-28", pay_amt: "1500.00", pts_earn: 15, pts_spend: 0, discount_type: "NONE" },
      { pay_id: 1005, res_id: 1004, pay_type: "Initial", pay_method: "Cash", pay_date: "2026-10-20", pay_amt: "3000.00", pts_earn: 30, pts_spend: 0, discount_type: "NONE" },
    ]);
    expect(await rows("SELECT rct_no, pay_id FROM bookinn.receipt ORDER BY 1")).toEqual(
      [1001, 1002, 1003, 1004, 1005].map((n) => ({ rct_no: n, pay_id: n })),
    );
    expect(await rows("SELECT cancel_id, res_id, cancel_date FROM bookinn.cancellation")).toEqual([
      { cancel_id: 9001, res_id: 1003, cancel_date: "2026-09-15" },
    ]);
    expect(
      await rows("SELECT charge_id, res_id, res_room_id, charge_type::text, ext_from, ext_to, charge_amt, pay_status::text, pay_id FROM bookinn.adjustment_charge ORDER BY 1"),
    ).toEqual([
      { charge_id: 7001, res_id: 1001, res_room_id: 10001, charge_type: "Extension", ext_from: "2026-06-27", ext_to: "2026-06-28", charge_amt: "1500.00", pay_status: "Paid", pay_id: 1004 },
      { charge_id: 7002, res_id: 1002, res_room_id: null, charge_type: "Modification", ext_from: null, ext_to: null, charge_amt: "3000.00", pay_status: "Unpaid", pay_id: null },
    ]);
    expect(await rows("SELECT refund_id, res_id, refund_type::text, refund_amt, refund_date FROM bookinn.refund")).toEqual([
      { refund_id: 8001, res_id: 1003, refund_type: "Cancellation", refund_amt: "6000.00", refund_date: "2026-09-15" },
    ]);
  });

  it("seeds the README test accounts with bcrypt hashes (Table 18 plus ADMIN and ETEGGERE)", async () => {
    expect(await rows("SELECT staff_id, u_name, role::text, is_active::text FROM bookinn.staff ORDER BY 1")).toEqual([
      { staff_id: 1001, u_name: "KDPALVARADO", role: "Front Desk", is_active: "Yes" },
      { staff_id: 1002, u_name: "JESMEDEL", role: "Finance", is_active: "Yes" },
      { staff_id: 1003, u_name: "ADMIN", role: "Database Administrator", is_active: "Yes" },
      { staff_id: 1004, u_name: "ETEGGERE", role: "Finance", is_active: "Yes" },
    ]);
    expect((await rows("SELECT pass FROM bookinn.staff")).every((r) => /^\$2[aby]\$/.test(String(r.pass)))).toBe(true);
  });

  it("loads the five SRS audit rows (Table 19) and never exposes password hashes", async () => {
    expect(
      await rows(`SELECT audit_id, staff_id, action::text, aff_tab::text, rec_id, to_char("timestamp", 'YYYY-MM-DD HH24:MI') AS ts, old_data, new_data
                    FROM bookinn.audit_trail WHERE audit_id <= 1005 ORDER BY 1`),
    ).toEqual([
      { audit_id: 1001, staff_id: 1001, action: "INSERT", aff_tab: "ADJUSTMENT_CHARGE", rec_id: "7001", ts: "2026-06-26 14:05", old_data: null, new_data: "RES_ID=1001; RES_ROOM_ID=10001; EXT_TO=2026-06-28" },
      { audit_id: 1002, staff_id: null, action: "UPDATE", aff_tab: "LOYALTY_ACC", rec_id: "5001", ts: "2026-06-28 11:45", old_data: "TOTAL_PTS=0", new_data: "TOTAL_PTS=75" },
      { audit_id: 1003, staff_id: 1001, action: "INSERT", aff_tab: "ADJUSTMENT_CHARGE", rec_id: "7002", ts: "2026-08-07 10:20", old_data: null, new_data: "RES_ID=1002; CHARGE_AMT=3000" },
      { audit_id: 1004, staff_id: 1001, action: "INSERT", aff_tab: "CANCELLATION", rec_id: "9001", ts: "2026-09-15 09:17", old_data: null, new_data: "RES_ID=1003" },
      { audit_id: 1005, staff_id: 1001, action: "INSERT", aff_tab: "REFUND", rec_id: "8001", ts: "2026-09-15 09:17", old_data: null, new_data: "RES_ID=1003; REFUND_AMT=6000" },
    ]);
    for (const r of await listRows(db, ADMIN, "staff")) expect(r).not.toHaveProperty("pass");
  });

  it("moves every ID counter past the sample rows", async () => {
    const next = async (table: string, col: string) =>
      Number((await db.query<{ v: number }>(`SELECT nextval(pg_get_serial_sequence('bookinn.${table}', '${col}'))::int AS v`)).rows[0].v);
    expect(await next("adjustment_charge", "charge_id")).toBe(7003);
    expect(await next("refund", "refund_id")).toBe(8002);
    expect(await next("payment", "pay_id")).toBe(1006);
    expect(await next("staff", "staff_id")).toBe(1005);
  });

  it("is safe to run twice", async () => {
    const { seed } = await import("@/lib/db/seed");
    expect(await seed(db, { admin: "A#1aaaaa", frontDesk: "B#1bbbbb", finance: "C#1ccccc", finance2: "D#1ddddd" }, 4)).toBe(false);
    expect(await count(db, "customer")).toBe(2);
  });
});

describe("audit trail integrity", () => {
  it("is append-only even for direct SQL", async () => {
    await expect(db.query("UPDATE bookinn.audit_trail SET old_data = 'x' WHERE audit_id = 1001")).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM bookinn.audit_trail WHERE audit_id = 1001")).rejects.toThrow(/append-only/);
  });

  it("records changes made outside the application (trigger-based), with no staff for system actions", async () => {
    await db.query("UPDATE bookinn.customer SET cus_mobile = '09060000000' WHERE cus_id = 1001");
    const r = await db.query("SELECT * FROM bookinn.audit_trail WHERE aff_tab = 'CUSTOMER' AND rec_id = '1001'");
    expect(r.rows).toEqual([
      expect.objectContaining({ action: "UPDATE", staff_id: null, old_data: "CUS_MOBILE=09061234567", new_data: "CUS_MOBILE=09060000000" }),
    ]);
  });

  it("audits ADJUSTMENT_CHARGE and REFUND", async () => {
    await db.query("UPDATE bookinn.adjustment_charge SET pay_status = 'Voided' WHERE charge_id = 7002");
    await db.query("INSERT INTO bookinn.refund (res_id, refund_type, refund_amt, refund_date) VALUES (1001, 'Checkout Credit', 0, '2026-06-28')");
    const r = await db.query<{ aff_tab: string; action: string; rec_id: string }>(
      "SELECT aff_tab::text, action::text, rec_id FROM bookinn.audit_trail WHERE audit_id > 1005 AND aff_tab IN ('ADJUSTMENT_CHARGE', 'REFUND') ORDER BY audit_id",
    );
    expect(r.rows).toEqual([
      { aff_tab: "ADJUSTMENT_CHARGE", action: "UPDATE", rec_id: "7002" },
      { aff_tab: "REFUND", action: "INSERT", rec_id: expect.stringMatching(/^80\d\d$/) },
    ]);
  });
});
