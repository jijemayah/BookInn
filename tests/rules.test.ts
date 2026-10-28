/** Business rules, delete guards, RBAC and authentication. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/types";
import { createRow, deleteRow, getRow, listRows, updateRow } from "@/lib/crud";
import { changeOwnPassword, readSessionToken, signSession, verifyCredentials } from "@/lib/staff-auth";
import { ADMIN, FINANCE, FRONT_DESK, PASSWORDS, freshDb } from "./helpers";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await freshDb()));
afterAll(() => close());

async function booking(room: string, inDate: string, outDate: string, cus = "1001") {
  const res = await createRow(db, FRONT_DESK, "reservation", { cus_id: cus });
  const rr = await createRow(db, FRONT_DESK, "reservation_room", {
    res_id: String(res.res_id), room_no: room, check_in_date: inDate, check_out_date: outDate,
  });
  return { resId: res.res_id as number, rrId: rr.res_room_id as number };
}

describe("unsafe deletion is prevented (FK RESTRICT + guard)", () => {
  it.each([
    ["customer", 1001, /1 loyalty accounts, 2 reservations/],
    ["room", 205, /reservation rooms/],
    ["room_details", "RT01", /3 rooms/],
    ["reservation", 1001, /reservation rooms, 1 payments/],
    ["payment", 1001, /1 receipts/],
    ["staff", 1001, /audit trail/],
  ] as const)("refuses to delete %s %s while dependents exist", async (key, id, msg) => {
    await expect(deleteRow(db, ADMIN, key, id)).rejects.toMatchObject({ code: "dependency", message: expect.stringMatching(msg) });
    expect(await getRow(db, ADMIN, key, id)).toBeTruthy(); // still there
  });

  it("backstops the guard with the database FK even if application checks are bypassed", async () => {
    await expect(db.query("DELETE FROM bookinn.customer WHERE cus_id = 1001")).rejects.toMatchObject({
      code: "23001", // restrict_violation
    });
  });
});

describe("double-booking prevention (FR-15, FR-16)", () => {
  it("rejects overlapping dates for a Booked room, allows back-to-back stays", async () => {
    const a = await booking("206", "2027-01-10", "2027-01-12");
    await expect(booking("206", "2027-01-11", "2027-01-13")).rejects.toMatchObject({
      code: "conflict", message: expect.stringContaining("Room 206 is already booked"),
    });
    const b = await booking("206", "2027-01-12", "2027-01-14"); // check-in on previous check-out day
    expect(b.rrId).toBeGreaterThan(a.rrId);
  });

  it("ignores Cancelled and Completed reservations", async () => {
    // Seeded reservation 1003 (Cancelled) held room 406 for 2026-09-25..29
    const c = await booking("406", "2026-09-26", "2026-09-28");
    expect(c.rrId).toBeTruthy();
    // Cancelling frees the room for others
    await createRow(db, FRONT_DESK, "cancellation", { res_id: String(c.resId), cancel_date: "2026-09-20", cancelled_by: "Customer" });
    expect((await booking("406", "2026-09-26", "2026-09-27")).rrId).toBeTruthy();
  });

  it("will not reinstate a cancellation whose room has since been rebooked", async () => {
    const c = await listRows(db, ADMIN, "cancellation", { q: "2026-09-20" });
    await expect(deleteRow(db, FRONT_DESK, "cancellation", c[0].cancel_id as number)).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects check-out on or before check-in", async () => {
    const res = await createRow(db, FRONT_DESK, "reservation", { cus_id: "1001" });
    await expect(
      createRow(db, FRONT_DESK, "reservation_room", {
        res_id: String(res.res_id), room_no: "205", check_in_date: "2027-02-02", check_out_date: "2027-02-02",
      }),
    ).rejects.toMatchObject({ code: "validation" });
  });
});

describe("payments", () => {
  it("rejects overpayment and partial payment; computes points; locks paid reservations", async () => {
    const { resId } = await booking("205", "2027-03-01", "2027-03-03", "1002"); // 2 × 1500 = 3000
    const base = { res_id: String(resId), pay_method: "Cash", pay_date: "2027-02-28", discount_type: "NONE" };
    await expect(createRow(db, FINANCE, "payment", { ...base, pay_amt: "3000.01" })).rejects.toMatchObject({
      message: expect.stringContaining("Overpayment"),
    });
    await expect(createRow(db, FINANCE, "payment", { ...base, pay_amt: "2999" })).rejects.toMatchObject({
      message: expect.stringContaining("paid once, in full"),
    });
    const p = await createRow(db, FINANCE, "payment", { ...base, pay_amt: "3000" });
    expect(p).toMatchObject({ pts_earn: 60, pts_spend: 0 });
    await expect(createRow(db, FINANCE, "payment", { ...base, pay_amt: "3000" })).rejects.toMatchObject({ code: "conflict" });
    // FR-14: once paid, reservation details are locked
    await expect(
      createRow(db, FRONT_DESK, "reservation_room", {
        res_id: String(resId), room_no: "206", check_in_date: "2027-03-01", check_out_date: "2027-03-02",
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("already been paid") });
  });

  it("applies 12% discount (100 pts) and refuses discounts without enough points", async () => {
    const { resId } = await booking("108", "2027-04-01", "2027-04-03", "1002"); // 6000 → 5280
    const p = await createRow(db, FINANCE, "payment", {
      res_id: String(resId), pay_method: "Card", pay_date: "2027-03-30", pay_amt: "5280", discount_type: "12% Discount",
    });
    expect(p).toMatchObject({ pts_spend: 100, pts_earn: 0 });

    const other = await booking("206", "2027-05-01", "2027-05-02", "1001"); // customer 1001 has 240 pts
    await expect(
      createRow(db, FINANCE, "payment", {
        res_id: String(other.resId), pay_method: "Card", pay_date: "2027-04-30", pay_amt: "0", discount_type: "Free Night",
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("needs 250 points") });

    // Free night on a 1-room, 1-night stay with enough points → amount due 0 (SRS edge case)
    const free = await booking("205", "2027-06-01", "2027-06-02", "1002"); // customer 1002 has 250 pts
    const fp = await createRow(db, FINANCE, "payment", {
      res_id: String(free.resId), pay_method: "Cash", pay_date: "2027-05-30", pay_amt: "0", discount_type: "Free Night",
    });
    expect(fp).toMatchObject({ pay_amt: "0.00", pts_spend: 250, pts_earn: 0 });
  });
});

describe("RBAC (FR-04 – FR-06)", () => {
  it("restricts writes and reads by role", async () => {
    await expect(createRow(db, FINANCE, "customer", { cus_name: "X", cus_email: "x@x.co", cus_mobile: "0917000000" }))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(createRow(db, FRONT_DESK, "payment", {})).rejects.toMatchObject({ code: "forbidden" });
    await expect(listRows(db, FRONT_DESK, "staff")).rejects.toMatchObject({ code: "forbidden" });
    await expect(listRows(db, FINANCE, "audit_trail")).rejects.toMatchObject({ code: "forbidden" });
    expect((await listRows(db, FINANCE, "reservation")).length).toBeGreaterThan(0);
  });

  it("prevents an admin from locking themselves out", async () => {
    await expect(
      updateRow(db, ADMIN, "staff", 1003, { u_name: "ADMIN", name: "System Administrator", role: "Finance", is_active: "true" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("validation", () => {
  it("rejects bad input with field errors", async () => {
    await expect(
      createRow(db, FRONT_DESK, "customer", { cus_name: "", cus_email: "not-an-email", cus_mobile: "12ab" }),
    ).rejects.toMatchObject({
      code: "validation",
      fieldErrors: { cus_name: expect.any(String), cus_email: expect.any(String), cus_mobile: expect.any(String) },
    });
    await expect(createRow(db, FRONT_DESK, "customer", { cus_name: "Dup", cus_email: "JDCRUZ@gmail.com", cus_mobile: "09170000000" }))
      .rejects.toMatchObject({ message: "A customer with this email already exists." });
    await expect(createRow(db, ADMIN, "staff", { u_name: "weak", name: "W", role: "Finance", pass: "password" }))
      .rejects.toMatchObject({ fieldErrors: { pass: expect.stringContaining("uppercase") } });
  });
});

describe("authentication", () => {
  it("verifies bcrypt credentials and blocks deactivated accounts", async () => {
    expect(await verifyCredentials(db, "kdpalvarado", PASSWORDS.frontDesk)).toMatchObject({ staffId: 1001, role: "Front Desk" });
    expect(await verifyCredentials(db, "KDPALVARADO", "wrong")).toBeNull();
    expect(await verifyCredentials(db, "nobody", "x")).toBeNull();
    await updateRow(db, ADMIN, "staff", 1002, { u_name: "JESMEDEL", name: "Jody Erich Medel", role: "Finance", is_active: "false" });
    expect(await verifyCredentials(db, "JESMEDEL", PASSWORDS.finance)).toBeNull();
    await updateRow(db, ADMIN, "staff", 1002, { u_name: "JESMEDEL", name: "Jody Erich Medel", role: "Finance", is_active: "true" });
  });

  it("lets staff change their own password", async () => {
    await expect(changeOwnPassword(db, 1001, "wrong", "New#Pass123")).rejects.toMatchObject({ code: "validation" });
    await changeOwnPassword(db, 1001, PASSWORDS.frontDesk, "New#Pass123");
    expect(await verifyCredentials(db, "KDPALVARADO", "New#Pass123")).not.toBeNull();
  });

  it("signs session tokens and rejects tampered ones", async () => {
    const token = await signSession(1003);
    expect(await readSessionToken(token)).toBe(1003);
    expect(await readSessionToken(token.slice(0, -2) + "xx")).toBeNull();
    expect(await readSessionToken(await signSession(1003, "another-secret-another-secret-123456"))).toBeNull();
  });
});
