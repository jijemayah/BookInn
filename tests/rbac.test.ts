/** Authentication, deactivation, role permissions and endpoint protection (FR-01 – FR-06). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/types";
import { createRow, deleteRow, listRows, updateRow } from "@/lib/crud";
import { cancelReservation, createBooking, quoteBooking } from "@/lib/booking";
import { dashboardStats } from "@/lib/dashboard";
import { changeOwnPassword, loadActiveStaff, readSessionToken, signSession, updateOwnName, verifyCredentials } from "@/lib/staff-auth";
import { isAuthorizedCron } from "@/lib/cron-auth";
import { ADMIN, FINANCE, FRONT_DESK, PASSWORDS, TODAY, freshDb } from "./helpers";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await freshDb()));
afterAll(() => close());

const booking = { cus_id: "1002", discount_type: "NONE", stays: [{ room_no: "205", check_in_date: "2027-01-05", check_out_date: "2027-01-06" }] };

describe("19. permissions follow the SRS permission table", () => {
  it("Finance can read everything operational but change nothing", async () => {
    for (const k of ["customer", "loyalty_acc", "room", "room_details", "reservation", "reservation_room", "payment", "receipt", "cancellation"] as const)
      expect(Array.isArray(await listRows(db, FINANCE, k))).toBe(true);
    expect((await dashboardStats(db, FINANCE, TODAY)).customers).toBe(2);
    await expect(createRow(db, FINANCE, "customer", { cus_name: "X", cus_email: "x@x.co", cus_mobile: "0917000000" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(quoteBooking(db, FINANCE, booking, TODAY)).rejects.toMatchObject({ code: "forbidden" });
    await expect(createBooking(db, FINANCE, { ...booking, pay_method: "Cash", pay_amt: "1500" }, TODAY)).rejects.toMatchObject({ code: "forbidden" });
    await expect(updateRow(db, FINANCE, "payment", 1001, { pay_method: "Cash", pay_date: "2026-06-20", pay_amt: "6000", discount_type: "NONE" }))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(cancelReservation(db, FINANCE, 1004, TODAY)).rejects.toMatchObject({ code: "forbidden" });
    await expect(createRow(db, FINANCE, "loyalty_acc", { cus_id: "1001" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(listRows(db, FINANCE, "staff")).rejects.toMatchObject({ code: "forbidden" });
    await expect(listRows(db, FINANCE, "audit_trail")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("Front Desk manages guests and bookings, reads rooms, and cannot touch staff, audit or room setup", async () => {
    const c = await createRow(db, FRONT_DESK, "customer", { cus_name: "Ana Reyes", cus_email: "ana@example.com", cus_mobile: "09171112222" });
    await updateRow(db, FRONT_DESK, "customer", c.cus_id as number, { cus_name: "Ana M. Reyes", cus_email: "ana@example.com", cus_mobile: "09171112222" });
    await expect(deleteRow(db, FRONT_DESK, "customer", c.cus_id as number)).rejects.toMatchObject({ code: "forbidden" });

    // Opening a loyalty account starts at 0; Front Desk cannot type a point balance.
    const l = await createRow(db, FRONT_DESK, "loyalty_acc", { cus_id: String(c.cus_id), total_pts: "999" });
    expect(l.total_pts).toBe(0);
    await expect(updateRow(db, FRONT_DESK, "loyalty_acc", l.lyl_id as number, { total_pts: "999" })).rejects.toMatchObject({ code: "forbidden" });

    expect((await listRows(db, FRONT_DESK, "room")).length).toBe(4);
    await expect(createRow(db, FRONT_DESK, "room", { room_no: "501", room_type_id: "RT01" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(updateRow(db, FRONT_DESK, "room_details", "RT01", { room_type: "Standard", room_price: "1", room_view: "Ocean View" }))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(createRow(db, FRONT_DESK, "payment", {})).rejects.toMatchObject({ code: "forbidden" });
    await expect(createRow(db, FRONT_DESK, "reservation", { cus_id: "1001" })).rejects.toMatchObject({
      code: "validation", message: expect.stringContaining("New booking form"),
    });
    await expect(listRows(db, FRONT_DESK, "staff")).rejects.toMatchObject({ code: "forbidden" });
    await expect(listRows(db, FRONT_DESK, "audit_trail")).rejects.toMatchObject({ code: "forbidden" });

    const b = await createBooking(db, FRONT_DESK, { ...booking, pay_method: "Cash", pay_amt: "1500" }, TODAY);
    await cancelReservation(db, FRONT_DESK, b.resId, TODAY);
  });

  it("the Database Administrator can do everything except edit or delete the audit trail", async () => {
    await createRow(db, ADMIN, "room", { room_no: "501", room_type_id: "RT02" });
    await deleteRow(db, ADMIN, "room", 501);
    expect((await listRows(db, ADMIN, "audit_trail")).length).toBeGreaterThan(2);
    await expect(createRow(db, ADMIN, "audit_trail", {})).rejects.toMatchObject({ code: "forbidden" });
    await expect(updateRow(db, ADMIN, "audit_trail", 1001, {})).rejects.toMatchObject({ code: "forbidden" });
    await expect(deleteRow(db, ADMIN, "audit_trail", 1001)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses to delete records that other records depend on", async () => {
    for (const [key, id] of [["customer", 1001], ["room", 205], ["room_details", "RT01"], ["reservation", 1001], ["payment", 1001], ["staff", 1001]] as const)
      await expect(deleteRow(db, ADMIN, key, id)).rejects.toMatchObject({ code: "dependency" });
  });

  it("prevents an administrator from locking everyone out", async () => {
    await expect(updateRow(db, ADMIN, "staff", 1003, { u_name: "ADMIN", name: "System Administrator", role: "Finance", is_active: "Yes" }))
      .rejects.toMatchObject({ code: "conflict" });
    await expect(updateRow(db, ADMIN, "staff", 1003, { u_name: "ADMIN", name: "System Administrator", role: "Database Administrator", is_active: "No" }))
      .rejects.toMatchObject({ code: "conflict" });
    await expect(deleteRow(db, ADMIN, "staff", 1003)).rejects.toMatchObject({ code: expect.stringMatching(/conflict|dependency/) });
  });
});

describe("18. authentication and deactivation", () => {
  it("verifies bcrypt credentials, case-insensitive usernames", async () => {
    expect(await verifyCredentials(db, "kdpalvarado", PASSWORDS.frontDesk)).toMatchObject({ staffId: 1001, role: "Front Desk" });
    expect(await verifyCredentials(db, "KDPALVARADO", "wrong")).toBeNull();
    expect(await verifyCredentials(db, "nobody", "x")).toBeNull();
  });

  it("a deactivated account can neither sign in nor keep using an existing session", async () => {
    expect(await loadActiveStaff(db, 1002)).not.toBeNull();
    await updateRow(db, ADMIN, "staff", 1002, { u_name: "JESMEDEL", name: "Jody Erich Medel", role: "Finance", is_active: "No" });
    expect(await verifyCredentials(db, "JESMEDEL", PASSWORDS.finance)).toBeNull();
    expect(await loadActiveStaff(db, 1002)).toBeNull(); // session check fails on the next request
    await updateRow(db, ADMIN, "staff", 1002, { u_name: "JESMEDEL", name: "Jody Erich Medel", role: "Finance", is_active: "Yes" });
    expect(await verifyCredentials(db, "JESMEDEL", PASSWORDS.finance)).not.toBeNull();
  });

  it("enforces unique usernames and the password policy", async () => {
    await expect(createRow(db, ADMIN, "staff", { u_name: "kdpalvarado", name: "Dup", role: "Finance", pass: "Strong#Pass1", is_active: "Yes" }))
      .rejects.toMatchObject({ code: "conflict" });
    await expect(createRow(db, ADMIN, "staff", { u_name: "weak", name: "W", role: "Finance", pass: "password", is_active: "Yes" }))
      .rejects.toMatchObject({ fieldErrors: { pass: expect.stringContaining("uppercase") } });
  });

  it("lets staff manage their own account (FR-03)", async () => {
    await expect(changeOwnPassword(db, 1002, "wrong", "New#Pass123")).rejects.toMatchObject({ code: "validation" });
    await changeOwnPassword(db, 1002, PASSWORDS.finance, "New#Pass123");
    expect(await verifyCredentials(db, "JESMEDEL", "New#Pass123")).not.toBeNull();
    await updateOwnName(db, 1002, "Jody E. Medel");
    expect((await loadActiveStaff(db, 1002))?.name).toBe("Jody E. Medel");
    const audit = await db.query("SELECT new_data, staff_id FROM bookinn.audit_trail WHERE aff_tab = 'STAFF' AND rec_id = '1002' ORDER BY audit_id");
    expect(audit.rows.every((a) => !String(a.new_data).includes("$2"))).toBe(true); // hashes never logged
    expect(audit.rows.at(-1)).toMatchObject({ staff_id: 1002, new_data: "NAME=Jody E. Medel" });
  });

  it("signs session tokens and rejects tampered ones", async () => {
    const token = await signSession(1003);
    expect(await readSessionToken(token)).toBe(1003);
    expect(await readSessionToken(token.slice(0, -2) + "xx")).toBeNull();
    expect(await readSessionToken(await signSession(1003, "another-secret-another-secret-123456"))).toBeNull();
  });
});

describe("20. unauthorized access to endpoints is rejected", () => {
  it("the cron endpoint requires the CRON_SECRET bearer token", async () => {
    const secret = "cron-secret-cron-secret-123";
    expect(isAuthorizedCron(null, secret)).toBe(false);
    expect(isAuthorizedCron("Bearer wrong", secret)).toBe(false);
    expect(isAuthorizedCron(`Bearer ${secret}`, undefined)).toBe(false);
    expect(isAuthorizedCron(`Bearer ${secret}`, secret)).toBe(true);

    const { GET } = await import("@/app/api/cron/maintenance/route");
    const res = await GET(new Request("http://localhost/api/cron/maintenance"));
    expect(res.status).toBe(401);
  });
});
