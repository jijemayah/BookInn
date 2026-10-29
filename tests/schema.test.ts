/** Schema shape, seed data, RLS and audit-trail integrity. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/types";
import { getRow, listRows } from "@/lib/crud";
import { ADMIN, count, freshDb, points } from "./helpers";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await freshDb()));
afterAll(() => close());

describe("schema (SRS §4.3 / §4.4)", () => {
  it("creates exactly the 11 SRS tables in schema bookinn", async () => {
    const r = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'bookinn' AND table_name <> 'schema_migrations' ORDER BY 1`,
    );
    expect(r.rows.map((x) => x.table_name)).toEqual([
      "audit_trail", "cancellation", "customer", "loyalty_acc", "payment", "receipt",
      "reservation", "reservation_room", "room", "room_details", "staff",
    ]);
  });

  it("matches the revised data dictionary columns", async () => {
    const cols = async (t: string) =>
      (
        await db.query<{ column_name: string; data_type: string; is_nullable: string; character_maximum_length: number | null; udt_name: string }>(
          `SELECT column_name, data_type, is_nullable, character_maximum_length, udt_name FROM information_schema.columns
            WHERE table_schema = 'bookinn' AND table_name = $1 ORDER BY ordinal_position`,
          [t],
        )
      ).rows;
    expect((await cols("cancellation")).map((c) => c.column_name)).toEqual(["cancel_id", "res_id", "cancel_date"]);
    expect((await cols("staff")).find((c) => c.column_name === "is_active")).toMatchObject({ udt_name: "yes_no_t" });
    const audit = Object.fromEntries((await cols("audit_trail")).map((c) => [c.column_name, c]));
    expect(audit.staff_id.is_nullable).toBe("YES");
    expect(audit.rec_id).toMatchObject({ data_type: "character varying", character_maximum_length: 50 });
    expect(audit.old_data.data_type).toBe("text");
    expect(audit.new_data.data_type).toBe("text");
    expect(audit.timestamp.data_type).toBe("timestamp without time zone");
  });

  it("marks the one-per-record columns unique", async () => {
    const r = await db.query<{ conname: string }>(
      `SELECT c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = 'bookinn' AND c.contype = 'u' ORDER BY 1`,
    );
    expect(r.rows.map((x) => x.conname)).toEqual(
      expect.arrayContaining(["cancellation_res_uq", "customer_email_uq", "loyalty_acc_cus_uq", "payment_res_uq", "receipt_pay_uq", "staff_u_name_uq"]),
    );
  });

  it("uses ON DELETE RESTRICT for every foreign key (no cascades)", async () => {
    const r = await db.query<{ confdeltype: string }>(
      `SELECT c.confdeltype FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = 'bookinn' AND c.contype = 'f'`,
    );
    expect(r.rows.length).toBe(9);
    expect(r.rows.every((x) => x.confdeltype === "r")).toBe(true);
  });

  it("enables Row Level Security on every table", async () => {
    const r = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'bookinn' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'`,
    );
    expect(r.rows).toHaveLength(11);
    expect(r.rows.every((x) => x.relrowsecurity)).toBe(true);
  });

  it("rejects negative amounts and points", async () => {
    await expect(db.query("UPDATE bookinn.loyalty_acc SET total_pts = -1 WHERE lyl_id = 5001")).rejects.toMatchObject({ code: "23514" });
    await expect(db.query("UPDATE bookinn.payment SET pay_amt = -1 WHERE pay_id = 1001")).rejects.toMatchObject({ code: "23514" });
    await expect(db.query("UPDATE bookinn.room_details SET room_price = -1 WHERE room_type_id = 'RT01'")).rejects.toMatchObject({ code: "23514" });
  });
});

describe("seed data (SRS 3NF sample, corrected)", () => {
  it("loads the sample rows with the documented corrections", async () => {
    expect(await count(db, "customer")).toBe(2);
    expect(await count(db, "room")).toBe(4);
    expect(await points(db, 5001)).toBe(300); // 120 + 120 + 60 (demo booking 1004)
    expect(await points(db, 5002)).toBe(250);
    expect((await getRow(db, ADMIN, "reservation", 1001)).booking_status).toBe("Completed");
    expect((await getRow(db, ADMIN, "reservation", 1003)).booking_status).toBe("Cancelled");
    expect((await getRow(db, ADMIN, "reservation", 1004)).booking_status).toBe("Booked");
    expect((await getRow(db, ADMIN, "payment", 1002))).toMatchObject({ pay_amt: "5280.00", pts_spend: 100, discount_type: "12% Discount" });
    expect((await getRow(db, ADMIN, "reservation_room", 10004)).check_in_date).toBe("2026-09-25");
    expect(await count(db, "receipt")).toBe(4);
    expect((await getRow(db, ADMIN, "staff", 1002)).is_active).toBe("Yes");
  });

  it("is safe to run twice", async () => {
    const { seed } = await import("@/lib/db/seed");
    expect(await seed(db, { admin: "A#1aaaaa", frontDesk: "B#1bbbbb", finance: "C#1ccccc" }, 4)).toBe(false);
    expect(await count(db, "customer")).toBe(2);
  });

  it("contains only the two SRS sample audit rows, and never exposes password hashes", async () => {
    const audit = await listRows(db, ADMIN, "audit_trail");
    expect(audit.map((a) => a.audit_id).sort()).toEqual([1001, 1002]);
    for (const r of await listRows(db, ADMIN, "staff")) expect(r).not.toHaveProperty("pass");
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
});
