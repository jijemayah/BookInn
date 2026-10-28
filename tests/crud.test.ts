/**
 * Create → Read → Update → Delete for each of the 11 SRS entities, run against
 * a real Postgres engine (PGlite) using the production migrations and services.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/types";
import { createRow, deleteRow, getRow, listRows, updateRow } from "@/lib/crud";
import { ADMIN, FINANCE, FRONT_DESK, auditFor, freshDb } from "./helpers";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await freshDb()));
afterAll(() => close());

describe("schema", () => {
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

  it("uses ON DELETE RESTRICT for every foreign key (no cascades)", async () => {
    const r = await db.query<{ conname: string; confdeltype: string }>(
      `SELECT c.conname, c.confdeltype FROM pg_constraint c
         JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = 'bookinn' AND c.contype = 'f'`,
    );
    expect(r.rows.length).toBe(9);
    expect(r.rows.every((x) => x.confdeltype === "r")).toBe(true);
  });

  it("has no triggers or jobs that delete customers (Phase 1 retention exception)", async () => {
    const r = await db.query(
      `SELECT tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'bookinn' AND NOT t.tgisinternal AND c.relname = 'customer'`,
    );
    expect(r.rows).toEqual([]);
  });
});

describe("corrected seed data", () => {
  it("loads the SRS sample rows with corrections applied", async () => {
    expect((await getRow(db, ADMIN, "loyalty_acc", 5001)).total_pts).toBe(240);
    expect((await getRow(db, ADMIN, "reservation", 1001)).booking_status).toBe("Completed");
    expect((await getRow(db, ADMIN, "reservation", 1003)).booking_status).toBe("Cancelled");
    expect((await getRow(db, ADMIN, "payment", 1002)).pay_amt).toBe("5280.00");
    expect((await getRow(db, ADMIN, "reservation_room", 10004)).check_in_date).toBe("2026-09-25");
    expect(await listRows(db, ADMIN, "receipt")).toHaveLength(3);
  });

  it("never exposes password hashes through the CRUD layer", async () => {
    const rows = await listRows(db, ADMIN, "staff");
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r).not.toHaveProperty("pass");
  });
});

describe("CRUD lifecycle per entity", () => {
  it("ROOM_DETAILS (natural varchar PK)", async () => {
    const c = await createRow(db, ADMIN, "room_details", {
      room_type_id: "RT09", room_type: "Deluxe", room_price: "4200.50", room_view: "City View",
    });
    expect(c.room_type_id).toBe("RT09");
    expect((await getRow(db, ADMIN, "room_details", "RT09")).room_price).toBe("4200.50");
    const u = await updateRow(db, ADMIN, "room_details", "RT09", {
      room_type: "Deluxe", room_price: "4500", room_view: "Garden View",
    });
    expect(u.room_view).toBe("Garden View");
    await deleteRow(db, ADMIN, "room_details", "RT09");
    await expect(getRow(db, ADMIN, "room_details", "RT09")).rejects.toMatchObject({ code: "not_found" });
    const audit = await auditFor(db, "ROOM_DETAILS", null);
    expect(audit.map((a) => a.action)).toEqual(["INSERT", "UPDATE", "DELETE"]);
    expect(audit[0].new_data).toContain("ROOM_TYPE_ID=RT09");
  });

  it("ROOM", async () => {
    await createRow(db, FRONT_DESK, "room", { room_no: "501", room_type_id: "RT01" });
    expect((await getRow(db, FRONT_DESK, "room", 501)).room_type_id__label).toContain("Standard");
    await updateRow(db, FRONT_DESK, "room", 501, { room_type_id: "RT02" });
    expect((await getRow(db, FRONT_DESK, "room", 501)).room_type_id).toBe("RT02");
    await deleteRow(db, FRONT_DESK, "room", 501);
    await expect(getRow(db, FRONT_DESK, "room", 501)).rejects.toMatchObject({ code: "not_found" });
  });

  it("CUSTOMER", async () => {
    const c = await createRow(db, FRONT_DESK, "customer", {
      cus_name: "Maria Santos", cus_email: "Maria.Santos@Example.com", cus_mobile: "09171234567",
    });
    expect(c.cus_id).toBe(1003); // identity continues after seeded IDs
    expect(c.cus_email).toBe("maria.santos@example.com");
    const u = await updateRow(db, FRONT_DESK, "customer", c.cus_id as number, {
      cus_name: "Maria L. Santos", cus_email: "maria.santos@example.com", cus_mobile: "09179999999",
    });
    expect(u.cus_mobile).toBe("09179999999");
    expect((await listRows(db, FRONT_DESK, "customer", { q: "santos" })).map((r) => r.cus_id)).toEqual([1003]);
    await deleteRow(db, FRONT_DESK, "customer", 1003); // no dependents → allowed
    const audit = await auditFor(db, "CUSTOMER", 1003);
    expect(audit.map((a) => a.action)).toEqual(["INSERT", "UPDATE", "DELETE"]);
    expect(audit[1]).toMatchObject({ old_data: expect.stringContaining("CUS_NAME=Maria Santos"), staff_id: 1001 });
  });

  it("LOYALTY_ACC", async () => {
    const cus = await createRow(db, FRONT_DESK, "customer", {
      cus_name: "Loyal Guest", cus_email: "loyal@example.com", cus_mobile: "09170000001",
    });
    const l = await createRow(db, FRONT_DESK, "loyalty_acc", { cus_id: String(cus.cus_id) });
    expect(l).toMatchObject({ lyl_id: 5003, total_pts: 0 });
    await expect(createRow(db, FRONT_DESK, "loyalty_acc", { cus_id: String(cus.cus_id) })).rejects.toMatchObject({
      message: "This customer already has a loyalty account.",
    });
    expect((await updateRow(db, FINANCE, "loyalty_acc", 5003, { total_pts: "75" })).total_pts).toBe(75);
    await deleteRow(db, FRONT_DESK, "loyalty_acc", 5003);
    await deleteRow(db, FRONT_DESK, "customer", cus.cus_id as number);
  });

  it("RESERVATION + RESERVATION_ROOM + PAYMENT + RECEIPT + CANCELLATION", async () => {
    // Create
    const res = await createRow(db, FRONT_DESK, "reservation", { cus_id: "1002", booking_status: "Completed" });
    expect(res.booking_status).toBe("Booked"); // new bookings always start Booked
    const rr = await createRow(db, FRONT_DESK, "reservation_room", {
      res_id: String(res.res_id), room_no: "205", check_in_date: "2026-12-01", check_out_date: "2026-12-03",
    });
    // Update room dates while unpaid
    await updateRow(db, FRONT_DESK, "reservation_room", rr.res_room_id as number, {
      room_no: "108", check_in_date: "2026-12-01", check_out_date: "2026-12-04",
    });
    const rrNow = await getRow(db, FRONT_DESK, "reservation_room", rr.res_room_id as number);
    expect(rrNow).toMatchObject({ room_no: 108, check_out_date: "2026-12-04" });

    // Payment: 3 nights × 3000 = 9000; customer 1002 has a loyalty account → 9000/50 = 180 pts
    const pay = await createRow(db, FINANCE, "payment", {
      res_id: String(res.res_id), pay_method: "Card", pay_date: "2026-11-30", pay_amt: "9000", discount_type: "NONE",
    });
    expect(pay).toMatchObject({ pay_amt: "9000.00", pts_earn: 180, pts_spend: 0 });
    const receipts = await listRows(db, FINANCE, "receipt", { q: String(pay.pay_id) });
    const rct = receipts.find((r) => r.pay_id === pay.pay_id)!;
    expect(rct).toBeTruthy(); // receipt auto-generated

    const pu = await updateRow(db, FINANCE, "payment", pay.pay_id as number, {
      pay_method: "Bank", pay_date: "2026-11-30", pay_amt: "9000.00", discount_type: "NONE",
    });
    expect(pu.pay_method).toBe("Bank");

    // Cancellation sets status, update edits it
    const can = await createRow(db, FRONT_DESK, "cancellation", {
      res_id: String(res.res_id), cancel_date: "2026-11-30", cancelled_by: "Staff",
    });
    expect((await getRow(db, FRONT_DESK, "reservation", res.res_id as number)).booking_status).toBe("Cancelled");
    expect((await updateRow(db, FRONT_DESK, "cancellation", can.cancel_id as number, {
      cancel_date: "2026-12-01", cancelled_by: "Customer",
    })).cancelled_by).toBe("Customer");

    // Delete (children first — parents are protected while history exists)
    await expect(deleteRow(db, FRONT_DESK, "reservation", res.res_id as number)).rejects.toMatchObject({
      code: "dependency",
    });
    await deleteRow(db, FRONT_DESK, "cancellation", can.cancel_id as number);
    expect((await getRow(db, FRONT_DESK, "reservation", res.res_id as number)).booking_status).toBe("Booked");
    await deleteRow(db, FINANCE, "receipt", rct.rct_no as number);
    await deleteRow(db, FINANCE, "payment", pay.pay_id as number);
    await deleteRow(db, FRONT_DESK, "reservation_room", rr.res_room_id as number);
    await deleteRow(db, FRONT_DESK, "reservation", res.res_id as number);
    await expect(getRow(db, FRONT_DESK, "reservation", res.res_id as number)).rejects.toMatchObject({ code: "not_found" });

    // RECEIPT create on its own (for a payment that lacks one)
    const audit = await auditFor(db, "RESERVATION", res.res_id as number);
    expect(audit.map((a) => a.action)).toEqual(["INSERT", "UPDATE", "UPDATE", "DELETE"]); // create, cancel, reinstate, delete
  });

  it("RECEIPT can be re-issued manually for a payment without one", async () => {
    await deleteRow(db, ADMIN, "receipt", 1003);
    const r = await createRow(db, ADMIN, "receipt", { pay_id: "1003" });
    expect((await getRow(db, ADMIN, "receipt", r.rct_no as number)).pay_id).toBe(1003);
    await expect(updateRow(db, ADMIN, "receipt", r.rct_no as number, { pay_id: "1001" })).rejects.toMatchObject({
      code: "validation",
    });
  });

  it("STAFF (bcrypt-hashed, deactivation instead of deletion)", async () => {
    const s = await createRow(db, ADMIN, "staff", {
      u_name: "NEWCLERK", name: "New Clerk", role: "Front Desk", pass: "Clerk#Pass1", is_active: "true",
    });
    const hash = (await db.query("SELECT pass FROM bookinn.staff WHERE staff_id = $1", [s.staff_id])).rows[0].pass;
    expect(hash).toMatch(/^\$2[aby]\$/);
    const u = await updateRow(db, ADMIN, "staff", s.staff_id as number, {
      u_name: "NEWCLERK", name: "New Clerk", role: "Finance", pass: "", is_active: "false",
    });
    expect(u).toMatchObject({ role: "Finance", is_active: false });
    const hashAfter = (await db.query("SELECT pass FROM bookinn.staff WHERE staff_id = $1", [s.staff_id])).rows[0].pass;
    expect(hashAfter).toBe(hash); // blank password on edit keeps the old one
    await deleteRow(db, ADMIN, "staff", s.staff_id as number); // no audit history as actor → deletable
    const audit = await auditFor(db, "STAFF", s.staff_id as number);
    expect(audit.every((a) => !String(a.new_data ?? "").includes("$2"))).toBe(true); // hash never logged
  });

  it("AUDIT_TRAIL is readable by the administrator but append-only", async () => {
    const rows = await listRows(db, ADMIN, "audit_trail");
    expect(rows.length).toBeGreaterThan(2);
    await expect(createRow(db, ADMIN, "audit_trail", {})).rejects.toMatchObject({ code: "forbidden" });
    await expect(deleteRow(db, ADMIN, "audit_trail", 1001)).rejects.toMatchObject({ code: "forbidden" });
    await expect(db.query("DELETE FROM bookinn.audit_trail WHERE audit_id = 1001")).rejects.toThrow(/append-only/);
  });
});
