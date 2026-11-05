/**
 * Daily job (SRS v2 §3.3 Scheduled and Automatic Actions: No-Show, Completed,
 * retention purge) and 25. dashboard figures, on the seeded SRS sample data.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/types";
import { dashboardStats, roomAvailability } from "@/lib/dashboard";
import { runMaintenance } from "@/lib/maintenance";
import { FINANCE, FRONT_DESK, TODAY, count, freshDb, points } from "./helpers";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await freshDb()));
afterAll(() => close());

const status = async (resId: number) =>
  (await db.query<{ s: string }>("SELECT booking_status::text AS s FROM bookinn.reservation WHERE res_id = $1", [resId])).rows[0]?.s;

describe("25. dashboard figures and room availability match the database", () => {
  it("computes the summary from the data", async () => {
    const s = await dashboardStats(db, FINANCE, TODAY);
    expect(s).toMatchObject({
      customers: 2, rooms: 4, booked: 2, completed: 1, cancelled: 1, upcoming: 1, inHouse: 0,
      payments: 5, revenueCents: (6000 + 5280 + 6000 + 1500 + 3000) * 100, revenueThisMonthCents: 0,
      loyaltyAccounts: 2, loyaltyPoints: 325, availableTonight: 4,
    });
    expect(s.nextArrivals).toEqual([expect.objectContaining({ res_id: 1004, room_no: 206, check_in_date: "2026-12-20" })]);
    const oct = await dashboardStats(db, FINANCE, "2026-10-29");
    expect(oct.revenueThisMonthCents).toBe(300_000); // payment 1005 on 2026-10-20
  });

  it("availability uses half-open stays and ignores Cancelled reservations", async () => {
    const during = await roomAvailability(db, FRONT_DESK, "2026-12-21", "2026-12-22");
    expect(during.find((r) => r.room_no === 206)).toMatchObject({ available: false, blocked_by: 1004 });
    expect(during.filter((r) => r.available).map((r) => r.room_no)).toEqual([108, 205, 406]);
    const checkoutDay = await roomAvailability(db, FRONT_DESK, "2026-12-22", "2026-12-23");
    expect(checkoutDay.find((r) => r.room_no === 206)?.available).toBe(true);
    expect((await roomAvailability(db, FRONT_DESK, "2026-09-25", "2026-09-29")).find((r) => r.room_no === 406)?.available).toBe(true);
  });
});

describe("daily job, step 1: No-Show", () => {
  it("sets 1002 to No-Show the day after its latest check-out, voids its Unpaid charge, keeps spent points", async () => {
    expect((await runMaintenance(db, { today: "2026-10-11" })).noShows).toEqual([]); // check-out day itself
    const r = await runMaintenance(db, { today: TODAY });
    expect(r).toMatchObject({ noShows: [1002], completed: 0, purged: 0 });
    expect(await status(1002)).toBe("No-Show");
    expect((await db.query("SELECT pay_status::text AS s FROM bookinn.adjustment_charge WHERE charge_id = 7002")).rows[0].s).toBe("Voided");
    expect(await points(db, 5002)).toBe(250); // the 100 spent points are not returned
    const audit = await db.query("SELECT staff_id, new_data FROM bookinn.audit_trail WHERE aff_tab = 'RESERVATION' AND rec_id = '1002'");
    expect(audit.rows).toEqual([{ staff_id: null, new_data: "BOOKING_STATUS=No-Show" }]); // system action
    expect((await runMaintenance(db, { today: TODAY })).noShows).toEqual([]); // idempotent
  });

  it("does not touch a reservation with a checked-in room", async () => {
    const r = await db.query<{ res_id: number }>("INSERT INTO bookinn.reservation (cus_id) VALUES (1002) RETURNING res_id");
    const resId = r.rows[0].res_id;
    await db.query(
      `INSERT INTO bookinn.reservation_room (res_id, room_no, check_in_date, check_out_date, actual_check_in) VALUES
         ($1, 205, '2027-01-05', '2027-01-06', '2027-01-05 14:00'), ($1, 108, '2027-01-05', '2027-01-07', NULL)`,
      [resId],
    );
    expect((await runMaintenance(db, { today: "2027-01-08" })).noShows).not.toContain(resId);
    expect(await status(resId)).toBe("Booked"); // left for staff to correct; never No-Show
  });
});

describe("daily job, step 2: Completed", () => {
  it("completes a Checked-In reservation once no room is checked in or expected and nothing is Unpaid, crediting points", async () => {
    // Room 206 checked in and out; room 406 never checked in, expected until 2027-03-05.
    const r = await db.query<{ res_id: number }>("INSERT INTO bookinn.reservation (cus_id) VALUES (1001) RETURNING res_id");
    const resId = r.rows[0].res_id;
    await db.query(
      `INSERT INTO bookinn.reservation_room (res_id, room_no, check_in_date, check_out_date, actual_check_in, actual_check_out) VALUES
         ($1, 206, '2027-03-01', '2027-03-03', '2027-03-01 14:00', '2027-03-03 11:00'), ($1, 406, '2027-03-01', '2027-03-05', NULL, NULL)`,
      [resId],
    );
    const p = await db.query<{ pay_id: number }>(
      "INSERT INTO bookinn.payment (res_id, pay_type, pay_method, pay_date, pay_amt, pts_earn) VALUES ($1, 'Initial', 'Cash', '2027-02-01', 9000, 90) RETURNING pay_id",
      [resId],
    );
    await db.query("INSERT INTO bookinn.receipt (pay_id) VALUES ($1)", [p.rows[0].pay_id]);
    await db.query("UPDATE bookinn.reservation SET booking_status = 'Checked-In' WHERE res_id = $1", [resId]);
    await db.query("INSERT INTO bookinn.adjustment_charge (res_id, charge_type, charge_amt) VALUES ($1, 'Modification', 1500)", [resId]);

    const before = await points(db, 5001);
    expect((await runMaintenance(db, { today: "2027-03-05" })).completed).toBe(0); // 406 still expected today
    expect((await runMaintenance(db, { today: "2027-03-06" })).completed).toBe(0); // Unpaid charge
    await db.query("UPDATE bookinn.adjustment_charge SET pay_status = 'Voided' WHERE res_id = $1", [resId]);
    expect((await runMaintenance(db, { today: "2027-03-06" })).completed).toBe(1);
    expect(await status(resId)).toBe("Completed");
    expect(await points(db, 5001)).toBe(before + 90);
    expect((await runMaintenance(db, { today: "2027-03-07" })).completed).toBe(0); // credited once
    expect(await points(db, 5001)).toBe(before + 90);
  });
});

describe("daily job, step 3: retention purge (FR-29)", () => {
  it("deletes 1001 and all its records one year after its latest check-out (2026-06-28), keeping the guest", async () => {
    const pts = await points(db, 5001);
    expect((await runMaintenance(db, { today: "2027-06-27" })).purged).toBe(0);
    expect((await runMaintenance(db, { today: "2027-06-28" })).purged).toBe(1);
    expect(await count(db, "reservation", "res_id = 1001")).toBe(0);
    expect(await count(db, "reservation_room", "res_id = 1001")).toBe(0);
    expect(await count(db, "payment", "res_id = 1001")).toBe(0);
    expect(await count(db, "receipt", "pay_id IN (1001, 1004)")).toBe(0);
    expect(await count(db, "adjustment_charge", "charge_id = 7001")).toBe(0);
    expect(await count(db, "customer", "cus_id = 1001")).toBe(1);
    expect(await points(db, 5001)).toBe(pts); // loyalty account and points kept
  });

  it("skips a reservation with an Unpaid charge until it is resolved, and includes refunds and cancellations", async () => {
    // 1003 (Cancelled, latest check-out 2026-09-29) gets an Unpaid charge for this test.
    await db.query("INSERT INTO bookinn.adjustment_charge (charge_id, res_id, charge_type, charge_amt) VALUES (7900, 1003, 'Modification', 100)");
    expect((await runMaintenance(db, { today: "2027-09-29" })).purged).toBe(0);
    expect(await count(db, "reservation", "res_id = 1003")).toBe(1);
    await db.query("UPDATE bookinn.adjustment_charge SET pay_status = 'Voided' WHERE charge_id = 7900");
    expect((await runMaintenance(db, { today: "2027-09-29" })).purged).toBe(1);
    expect(await count(db, "refund", "refund_id = 8001")).toBe(0);
    expect(await count(db, "cancellation", "cancel_id = 9001")).toBe(0);
    expect((await runMaintenance(db, { today: "2027-09-29" })).purged).toBe(0); // idempotent
  });

  it("logs the deletions with no staff ID and without copying the deleted data", async () => {
    const log = await db.query<{ staff_id: number | null; old_data: string; aff_tab: string }>(
      "SELECT staff_id, old_data, aff_tab::text FROM bookinn.audit_trail WHERE action = 'DELETE' AND old_data LIKE 'RETENTION%'",
    );
    const tables = new Set(log.rows.map((r) => r.aff_tab));
    for (const t of ["RESERVATION", "RESERVATION_ROOM", "PAYMENT", "RECEIPT", "ADJUSTMENT_CHARGE", "REFUND", "CANCELLATION"]) expect(tables).toContain(t);
    expect(log.rows.every((r) => r.staff_id === null && !r.old_data.includes("PAY_AMT"))).toBe(true);
    expect(await count(db, "customer")).toBe(2);
    expect(await count(db, "loyalty_acc")).toBe(2);
  });
});
