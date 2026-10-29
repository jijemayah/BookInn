/** Daily jobs (completion, 23. retention) and 25. dashboard figures. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/types";
import { createBooking } from "@/lib/booking";
import { getRow } from "@/lib/crud";
import { dashboardStats, roomAvailability } from "@/lib/dashboard";
import { runMaintenance } from "@/lib/maintenance";
import { ADMIN, FINANCE, FRONT_DESK, TODAY, count, freshDb, points } from "./helpers";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await freshDb()));
afterAll(() => close());

describe("25. dashboard figures and room availability match the database", () => {
  it("computes the summary from the data", async () => {
    const s = await dashboardStats(db, FINANCE, TODAY);
    expect(s).toMatchObject({
      customers: 2, rooms: 4, booked: 1, completed: 2, cancelled: 1, upcoming: 1, inHouse: 0,
      payments: 4, revenueCents: (6000 + 5280 + 6000 + 3000) * 100, revenueThisMonthCents: 0,
      loyaltyAccounts: 2, loyaltyPoints: 550, availableTonight: 4,
    });
    expect(s.nextArrivals).toEqual([expect.objectContaining({ res_id: 1004, room_no: 206, check_in_date: "2026-12-20" })]);
    const oct = await dashboardStats(db, FINANCE, "2026-10-29");
    expect(oct.revenueThisMonthCents).toBe(300_000); // payment 1004 on 2026-10-20
  });

  it("availability uses Booked reservations only, with half-open stays", async () => {
    const during = await roomAvailability(db, FRONT_DESK, "2026-12-21", "2026-12-22");
    expect(during.find((r) => r.room_no === 206)).toMatchObject({ available: false, blocked_by: 1004 });
    expect(during.filter((r) => r.available).map((r) => r.room_no)).toEqual([108, 205, 406]);
    const checkoutDay = await roomAvailability(db, FRONT_DESK, "2026-12-22", "2026-12-23");
    expect(checkoutDay.find((r) => r.room_no === 206)?.available).toBe(true);
    // Room 406 was held by cancelled reservation 1003: still free on those dates.
    expect((await roomAvailability(db, FRONT_DESK, "2026-09-25", "2026-09-29")).find((r) => r.room_no === 406)?.available).toBe(true);
  });
});

describe("Reservation Completion (SRS §3.3)", () => {
  it("marks a reservation Completed on the day after its latest check-out date", async () => {
    const b = await createBooking(
      db, FRONT_DESK,
      {
        cus_id: "1002", discount_type: "NONE", pay_method: "Cash", pay_amt: "4500",
        stays: [
          { room_no: "205", check_in_date: "2027-02-01", check_out_date: "2027-02-02" },
          { room_no: "406", check_in_date: "2027-02-01", check_out_date: "2027-02-03" },
        ],
      },
      TODAY,
    );
    expect((await runMaintenance(db, { today: "2027-02-03" })).completed).toBe(1); // only 1004 (Dec 2026) so far
    expect((await getRow(db, ADMIN, "reservation", b.resId)).booking_status).toBe("Booked"); // latest check-out is today
    expect((await getRow(db, ADMIN, "reservation", 1004)).booking_status).toBe("Completed");
    expect((await runMaintenance(db, { today: "2027-02-04" })).completed).toBe(1);
    expect((await getRow(db, ADMIN, "reservation", b.resId)).booking_status).toBe("Completed");
    const audit = await db.query("SELECT staff_id FROM bookinn.audit_trail WHERE aff_tab = 'RESERVATION' AND rec_id = $1 AND action = 'UPDATE'", [
      String(b.resId),
    ]);
    expect(audit.rows).toEqual([{ staff_id: null }]); // system action
  });
});

describe("23. Data Retention (SRS §1.4 / §3.3)", () => {
  it("deletes a reservation and its related records 1 year after the latest check-out, keeping the guest", async () => {
    const pts = await points(db, 5001);
    // Reservation 1001: latest check-out 2026-06-27.
    expect((await runMaintenance(db, { today: "2027-06-26" })).purged).toBe(0);
    expect((await runMaintenance(db, { today: "2027-06-27" })).purged).toBe(1);
    expect(await count(db, "reservation", "res_id = 1001")).toBe(0);
    expect(await count(db, "reservation_room", "res_id = 1001")).toBe(0);
    expect(await count(db, "payment", "pay_id = 1001")).toBe(0);
    expect(await count(db, "receipt", "pay_id = 1001")).toBe(0);
    expect(await count(db, "customer", "cus_id = 1001")).toBe(1);
    expect(await points(db, 5001)).toBe(pts); // loyalty account and points kept
    expect(await count(db, "reservation", "res_id IN (1002, 1003, 1004)")).toBe(3);
  });

  it("includes cancellations, is idempotent, and does not copy deleted data into the audit trail", async () => {
    // 1002 (check-out 2026-08-10), 1003 cancelled (2026-09-29) and 1004 (2026-12-22) expire by 2027-12-22.
    expect((await runMaintenance(db, { today: "2027-12-22" })).purged).toBe(3);
    expect(await count(db, "cancellation", "cancel_id = 9001")).toBe(0);
    expect((await runMaintenance(db, { today: "2027-12-22" })).purged).toBe(0);
    expect(await count(db, "customer")).toBe(2);
    expect(await count(db, "loyalty_acc")).toBe(2);

    const log = await db.query<{ staff_id: number | null; old_data: string; aff_tab: string }>(
      "SELECT staff_id, old_data, aff_tab::text FROM bookinn.audit_trail WHERE action = 'DELETE' AND old_data LIKE 'RETENTION%'",
    );
    // 4 receipts + 4 payments + 1 cancellation + 5 reserved rooms + 4 reservations
    expect(log.rows.length).toBe(18);
    expect(log.rows.every((r) => r.staff_id === null && !r.old_data.includes("PAY_AMT"))).toBe(true);
  });
});
