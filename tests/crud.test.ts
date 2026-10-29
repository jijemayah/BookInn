/**
 * 24. Create → Read → Update → Delete for each entity, and
 * 22. audit-trail entries for each change, against a real Postgres (PGlite)
 * using the production migrations and services.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/types";
import { createRow, deleteRow, getRow, listRows, pageRows, updateRow } from "@/lib/crud";
import { createBooking } from "@/lib/booking";
import { ADMIN, FRONT_DESK, TODAY, auditFor, freshDb, points } from "./helpers";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await freshDb()));
afterAll(() => close());

describe("CRUD lifecycle per entity", () => {
  it("CUSTOMER (Front Desk creates and updates; administrator deletes)", async () => {
    const c = await createRow(db, FRONT_DESK, "customer", {
      cus_name: "Maria Santos", cus_email: "Maria.Santos@Example.com", cus_mobile: "09171234567",
    });
    expect(c).toMatchObject({ cus_id: 1003, cus_email: "maria.santos@example.com" });
    const u = await updateRow(db, FRONT_DESK, "customer", 1003, {
      cus_name: "Maria L. Santos", cus_email: "maria.santos@example.com", cus_mobile: "09179999999",
    });
    expect(u.cus_mobile).toBe("09179999999");
    expect((await listRows(db, FRONT_DESK, "customer", { q: "santos" })).map((r) => r.cus_id)).toEqual([1003]);
    await deleteRow(db, ADMIN, "customer", 1003);
    await expect(getRow(db, ADMIN, "customer", 1003)).rejects.toMatchObject({ code: "not_found" });

    const audit = await auditFor(db, "CUSTOMER", 1003);
    expect(audit.map((a) => [a.action, a.staff_id])).toEqual([["INSERT", 1001], ["UPDATE", 1001], ["DELETE", 1003]]);
    expect(audit[1]).toMatchObject({ old_data: expect.stringContaining("CUS_NAME=Maria Santos"), new_data: expect.stringContaining("CUS_NAME=Maria L. Santos") });
  });

  it("rejects duplicate emails and bad input with field errors", async () => {
    await expect(createRow(db, FRONT_DESK, "customer", { cus_name: "Dup", cus_email: "JDCRUZ@gmail.com", cus_mobile: "09170000000" }))
      .rejects.toMatchObject({ message: "A customer with this email already exists." });
    await expect(createRow(db, FRONT_DESK, "customer", { cus_name: "", cus_email: "not-an-email", cus_mobile: "12ab" })).rejects.toMatchObject({
      code: "validation",
      fieldErrors: { cus_name: expect.any(String), cus_email: expect.any(String), cus_mobile: expect.any(String) },
    });
  });

  it("ROOM_DETAILS and ROOM (administrator; natural keys)", async () => {
    await createRow(db, ADMIN, "room_details", { room_type_id: "RT09", room_type: "Deluxe", room_price: "4200.50", room_view: "City View" });
    expect((await getRow(db, ADMIN, "room_details", "RT09")).room_price).toBe("4200.50");
    await updateRow(db, ADMIN, "room_details", "RT09", { room_type: "Deluxe", room_price: "4500", room_view: "Garden View" });
    await createRow(db, ADMIN, "room", { room_no: "501", room_type_id: "RT09" });
    expect((await getRow(db, FRONT_DESK, "room", 501)).room_type_id__label).toContain("Garden View");
    await updateRow(db, ADMIN, "room", 501, { room_type_id: "RT02" });
    await deleteRow(db, ADMIN, "room", 501);
    await deleteRow(db, ADMIN, "room_details", "RT09");
    const audit = await auditFor(db, "ROOM_DETAILS", "RT09");
    expect(audit.map((a) => a.action)).toEqual(["INSERT", "UPDATE", "DELETE"]); // varchar REC_ID now stored
    expect(audit[1]).toMatchObject({ old_data: "ROOM_PRICE=4200.50; ROOM_VIEW=City View", new_data: "ROOM_PRICE=4500.00; ROOM_VIEW=Garden View" });
  });

  it("LOYALTY_ACC (one per guest; points corrected only by the administrator)", async () => {
    const cus = await createRow(db, FRONT_DESK, "customer", { cus_name: "Loyal Guest", cus_email: "loyal@example.com", cus_mobile: "09170000001" });
    const l = await createRow(db, FRONT_DESK, "loyalty_acc", { cus_id: String(cus.cus_id) });
    expect(l).toMatchObject({ lyl_id: 5003, total_pts: 0 });
    await expect(createRow(db, FRONT_DESK, "loyalty_acc", { cus_id: String(cus.cus_id) })).rejects.toMatchObject({
      message: "This customer already has a loyalty account.",
    });
    expect((await updateRow(db, ADMIN, "loyalty_acc", 5003, { total_pts: "75" })).total_pts).toBe(75);
    await deleteRow(db, ADMIN, "loyalty_acc", 5003);
    await deleteRow(db, ADMIN, "customer", cus.cus_id as number);
  });

  it("RESERVATION, RESERVED ROOMS, PAYMENT, RECEIPT via the booking form; administrator corrections", async () => {
    const b = await createBooking(
      db, FRONT_DESK,
      { cus_id: "1002", discount_type: "NONE", stays: [{ room_no: "108", check_in_date: "2027-01-01", check_out_date: "2027-01-04" }], pay_method: "Card", pay_amt: "9000" },
      TODAY,
    );
    expect(await getRow(db, FRONT_DESK, "payment", b.payId)).toMatchObject({ pay_amt: "9000.00", pts_earn: 180 });

    // Correction: move the stay to another free room, then delete the correction row's history in order.
    const rr = (await listRows(db, ADMIN, "reservation_room", { filter: { field: "res_id", value: String(b.resId) } }))[0];
    await updateRow(db, ADMIN, "reservation_room", rr.res_room_id as number, { room_no: "108", check_in_date: "2027-01-02", check_out_date: "2027-01-05" });
    expect((await getRow(db, ADMIN, "reservation_room", rr.res_room_id as number)).check_in_date).toBe("2027-01-02");

    // Delete: children first (never cascades); deleting the payment takes back its points.
    const before = await points(db, 5002);
    await expect(deleteRow(db, ADMIN, "reservation", b.resId)).rejects.toMatchObject({ code: "dependency" });
    await deleteRow(db, ADMIN, "receipt", b.rctNo);
    await deleteRow(db, ADMIN, "payment", b.payId);
    expect(await points(db, 5002)).toBe(before - 180);
    await deleteRow(db, ADMIN, "reservation_room", rr.res_room_id as number);
    await deleteRow(db, ADMIN, "reservation", b.resId);

    const audit = await auditFor(db, "RESERVATION", b.resId);
    expect(audit.map((a) => [a.action, a.staff_id])).toEqual([["INSERT", 1001], ["DELETE", 1003]]);
    expect((await auditFor(db, "PAYMENT", b.payId)).map((a) => a.action)).toEqual(["INSERT", "DELETE"]);
    expect((await auditFor(db, "RECEIPT", b.rctNo)).map((a) => a.action)).toEqual(["INSERT", "DELETE"]);
  });

  it("RECEIPT can be re-issued by the administrator for a payment without one", async () => {
    await deleteRow(db, ADMIN, "receipt", 1003);
    const r = await createRow(db, ADMIN, "receipt", { pay_id: "1003" });
    expect((await getRow(db, ADMIN, "receipt", r.rct_no as number)).pay_id).toBe(1003);
  });

  it("CANCELLATION (Front Desk cancels; administrator corrects or reinstates)", async () => {
    const can = await createRow(db, FRONT_DESK, "cancellation", { res_id: "1004", cancel_date: TODAY }, TODAY);
    expect((await getRow(db, FRONT_DESK, "reservation", 1004)).booking_status).toBe("Cancelled");
    await expect(createRow(db, FRONT_DESK, "cancellation", { res_id: "1001", cancel_date: TODAY }, TODAY)).rejects.toMatchObject({ code: "conflict" });
    await expect(createRow(db, FRONT_DESK, "cancellation", { res_id: "1002", cancel_date: "2027-01-01" }, TODAY)).rejects.toMatchObject({ code: "conflict" });
    expect((await updateRow(db, ADMIN, "cancellation", can.cancel_id as number, { cancel_date: "2026-10-31" })).cancel_date).toBe("2026-10-31");
    await deleteRow(db, ADMIN, "cancellation", can.cancel_id as number);
    expect((await getRow(db, FRONT_DESK, "reservation", 1004)).booking_status).toBe("Booked");
    expect((await auditFor(db, "RESERVATION", 1004)).map((a) => a.new_data)).toEqual(["BOOKING_STATUS=Cancelled", "BOOKING_STATUS=Booked"]);
  });

  it("STAFF (bcrypt-hashed; deactivation instead of deletion)", async () => {
    const s = await createRow(db, ADMIN, "staff", { u_name: "NEWCLERK", name: "New Clerk", role: "Front Desk", pass: "Clerk#Pass1", is_active: "Yes" });
    const hash = (await db.query("SELECT pass FROM bookinn.staff WHERE staff_id = $1", [s.staff_id])).rows[0].pass;
    expect(hash).toMatch(/^\$2[aby]\$/);
    const u = await updateRow(db, ADMIN, "staff", s.staff_id as number, { u_name: "NEWCLERK", name: "New Clerk", role: "Finance", pass: "", is_active: "No" });
    expect(u).toMatchObject({ role: "Finance", is_active: "No" });
    expect((await db.query("SELECT pass FROM bookinn.staff WHERE staff_id = $1", [s.staff_id])).rows[0].pass).toBe(hash);
    await deleteRow(db, ADMIN, "staff", s.staff_id as number);
    const audit = await auditFor(db, "STAFF", s.staff_id as number);
    expect(audit.map((a) => a.action)).toEqual(["INSERT", "UPDATE", "DELETE"]);
    expect(audit.every((a) => !`${a.old_data}${a.new_data}`.includes("$2"))).toBe(true);
  });
});

describe("list pages: search, filter, sort, pagination", () => {
  it("pages, sorts and filters on declared columns only", async () => {
    const p = await pageRows(db, ADMIN, "reservation", { limit: 2, page: 2, sort: "res_id", dir: "desc" });
    expect(p.total).toBe(4);
    expect(p.rows.map((r) => r.res_id)).toEqual([1002, 1001]);
    const f = await pageRows(db, ADMIN, "reservation", { filters: { booking_status: "Completed" } });
    expect(f.rows.map((r) => r.res_id)).toEqual([1001, 1002]);
    expect((await pageRows(db, ADMIN, "reservation", { q: "keizzy" })).rows.map((r) => r.res_id)).toEqual([1002]);
    await expect(pageRows(db, ADMIN, "reservation", { filters: { "1=1; --": "x" } })).rejects.toMatchObject({ code: "validation" });
    expect((await pageRows(db, ADMIN, "reservation", { sort: "res_id; DROP TABLE x" })).sort).toBe("res_id");
  });
});
