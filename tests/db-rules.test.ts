/**
 * SRS v2 rules enforced by the database (migration 0005): payments, charges,
 * refunds, check-in/out events, room rules, delete rules, double booking,
 * reservation status rules, points at Completed, and the overdue view.
 * Uses the seeded SRS sample data (reservations 1001, 1002, 1003, demo 1004).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/types";
import { freshDb, points } from "./helpers";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await freshDb()));
afterAll(() => close());

/** Runs statements in one transaction with bookinn.today set, like the daily job does. */
async function onDay<T>(today: string, fn: (t: Db) => Promise<T>): Promise<T> {
  return db.tx(async (t) => {
    await t.query("SELECT set_config('bookinn.today', $1, true)", [today]);
    return fn(t);
  });
}

/** A new Booked reservation for guest 1001 with one room, paid by an Initial payment. */
async function newReservation(room: number, checkIn: string, checkOut: string, c: Db = db) {
  const r = await c.query<{ res_id: number }>("INSERT INTO bookinn.reservation (cus_id) VALUES (1001) RETURNING res_id");
  const resId = r.rows[0].res_id;
  const rr = await c.query<{ res_room_id: number }>(
    "INSERT INTO bookinn.reservation_room (res_id, room_no, check_in_date, check_out_date) VALUES ($1, $2, $3, $4) RETURNING res_room_id",
    [resId, room, checkIn, checkOut],
  );
  const p = await c.query<{ pay_id: number }>(
    "INSERT INTO bookinn.payment (res_id, pay_type, pay_method, pay_date, pay_amt) VALUES ($1, 'Initial', 'Cash', '2026-11-01', 0) RETURNING pay_id",
    [resId],
  );
  await c.query("INSERT INTO bookinn.receipt (pay_id) VALUES ($1)", [p.rows[0].pay_id]);
  return { resId, resRoomId: rr.rows[0].res_room_id, payId: p.rows[0].pay_id };
}

describe("PAYMENT: one Initial and at most one Checkout per reservation", () => {
  it("rejects a second Initial payment", async () => {
    await expect(
      db.query("INSERT INTO bookinn.payment (res_id, pay_type, pay_method, pay_date, pay_amt) VALUES (1002, 'Initial', 'Cash', '2026-11-01', 1)"),
    ).rejects.toMatchObject({ code: "23505", constraint: "payment_initial_uq" });
  });

  it("rejects a second Checkout payment (1001 already has payment 1004)", async () => {
    await expect(
      db.query("INSERT INTO bookinn.payment (res_id, pay_type, pay_method, pay_date, pay_amt) VALUES (1001, 'Checkout', 'Cash', '2026-11-01', 1)"),
    ).rejects.toMatchObject({ code: "23505", constraint: "payment_checkout_uq" });
  });

  it("allows one Checkout payment, which uses no discount and spends no points", async () => {
    await expect(
      db.query(
        "INSERT INTO bookinn.payment (res_id, pay_type, pay_method, pay_date, pay_amt, pts_spend, discount_type) VALUES (1004, 'Checkout', 'Cash', '2026-12-22', 100, 100, '12% Discount')",
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "payment_checkout_no_discount_chk" });
    await db.tx(async (t) => {
      await t.query("INSERT INTO bookinn.payment (res_id, pay_type, pay_method, pay_date, pay_amt) VALUES (1004, 'Checkout', 'Cash', '2026-12-22', 100)");
      await t.query("SELECT 1/0"); // roll back: keep 1004 clean for later tests
    }).catch(() => undefined);
    expect((await db.query("SELECT count(*)::int AS n FROM bookinn.payment WHERE res_id = 1004")).rows[0].n).toBe(1);
  });
});

describe("ADJUSTMENT_CHARGE", () => {
  it("a Modification charge belongs to the reservation only and may be negative", async () => {
    await expect(
      db.query("INSERT INTO bookinn.adjustment_charge (res_id, res_room_id, charge_type, charge_amt) VALUES (1002, 10003, 'Modification', 100)"),
    ).rejects.toMatchObject({ code: "23514", constraint: "adjustment_charge_type_chk" });
    const r = await db.query<{ charge_id: number }>(
      "INSERT INTO bookinn.adjustment_charge (res_id, charge_type, charge_amt) VALUES (1002, 'Modification', -1500) RETURNING charge_id",
    );
    await db.query("UPDATE bookinn.adjustment_charge SET pay_status = 'Voided' WHERE charge_id = $1", [r.rows[0].charge_id]);
  });

  it("an Extension charge names its room, has EXT_TO after EXT_FROM, and costs nights × ROOM_PRICE", async () => {
    await expect(
      db.query("INSERT INTO bookinn.adjustment_charge (res_id, charge_type, ext_from, ext_to, charge_amt) VALUES (1001, 'Extension', '2026-06-28', '2026-06-29', 1500)"),
    ).rejects.toMatchObject({ code: "23514", constraint: "adjustment_charge_extension_room" });
    await expect(
      db.query("INSERT INTO bookinn.adjustment_charge (res_id, res_room_id, charge_type, ext_from, ext_to, charge_amt) VALUES (1001, 10001, 'Extension', '2026-06-29', '2026-06-28', 0)"),
    ).rejects.toMatchObject({ code: "23514", constraint: "adjustment_charge_type_chk" });
    await expect(
      db.query("INSERT INTO bookinn.adjustment_charge (res_id, res_room_id, charge_type, ext_from, ext_to, charge_amt) VALUES (1001, 10001, 'Extension', '2026-06-28', '2026-06-30', 1500)"),
    ).rejects.toMatchObject({ code: "23514", constraint: "adjustment_charge_extension_amt" }); // 2 nights × 1500 = 3000
    await expect(
      db.query("INSERT INTO bookinn.adjustment_charge (res_id, res_room_id, charge_type, ext_from, ext_to, charge_amt) VALUES (1002, 10001, 'Extension', '2026-06-28', '2026-06-29', 1500)"),
    ).rejects.toMatchObject({ code: "23514", constraint: "adjustment_charge_room_res" }); // room row of another reservation
  });

  it("is settled only by the Checkout payment of its own reservation, and only when Paid", async () => {
    await expect(db.query("UPDATE bookinn.adjustment_charge SET pay_status = 'Paid', pay_id = 1002 WHERE charge_id = 7002")).rejects.toMatchObject({
      code: "23514", constraint: "adjustment_charge_checkout_payment", // 1002 is an Initial payment
    });
    await expect(db.query("UPDATE bookinn.adjustment_charge SET pay_status = 'Paid', pay_id = 1004 WHERE charge_id = 7002")).rejects.toMatchObject({
      code: "23514", constraint: "adjustment_charge_checkout_payment", // 1004 belongs to reservation 1001
    });
    await expect(db.query("UPDATE bookinn.adjustment_charge SET pay_status = 'Unpaid' WHERE charge_id = 7001")).rejects.toMatchObject({
      code: "23514", constraint: "adjustment_charge_paid_chk",
    });
  });
});

describe("REFUND", () => {
  it("allows at most one Cancellation refund per reservation", async () => {
    await expect(
      db.query("INSERT INTO bookinn.refund (res_id, refund_type, refund_amt, refund_date) VALUES (1003, 'Cancellation', 1, '2026-09-15')"),
    ).rejects.toMatchObject({ code: "23505", constraint: "refund_cancellation_uq" });
  });
});

describe("check-in and check-out events", () => {
  it("rejects a check-in before the check-in date and a check-out without or before the check-in", async () => {
    await expect(db.query("UPDATE bookinn.reservation_room SET actual_check_in = '2026-12-19 23:59' WHERE res_room_id = 10005")).rejects.toMatchObject({
      code: "23514", constraint: "reservation_room_actual_in_chk",
    });
    await expect(db.query("UPDATE bookinn.reservation_room SET actual_check_out = '2026-12-21 10:00' WHERE res_room_id = 10005")).rejects.toMatchObject({
      code: "23514", constraint: "reservation_room_actual_out_chk",
    });
    await expect(
      db.query("UPDATE bookinn.reservation_room SET actual_check_in = '2026-06-28 12:00' WHERE res_room_id = 10001"),
    ).rejects.toMatchObject({ code: "23514", constraint: "reservation_room_actual_out_chk" }); // after its check-out 11:40
  });
});

describe("room rules", () => {
  it("never changes ROOM_PRICE", async () => {
    await expect(db.query("UPDATE bookinn.room_details SET room_price = 1600 WHERE room_type_id = 'RT01'")).rejects.toMatchObject({
      code: "23514", constraint: "room_price_fixed",
    });
    await db.query("UPDATE bookinn.room_details SET room_view = 'City View' WHERE room_type_id = 'RT01'"); // other details may change
    await db.query("UPDATE bookinn.room_details SET room_view = 'Ocean View' WHERE room_type_id = 'RT01'");
  });

  it("locks a room's type once the room has a reservation", async () => {
    await expect(db.query("UPDATE bookinn.room SET room_type_id = 'RT02' WHERE room_no = 205")).rejects.toMatchObject({
      code: "23514", constraint: "room_type_locked",
    });
    await db.query("INSERT INTO bookinn.room (room_no, room_type_id) VALUES (999, 'RT01')");
    await db.query("UPDATE bookinn.room SET room_type_id = 'RT02' WHERE room_no = 999");
    await db.query("DELETE FROM bookinn.room WHERE room_no = 999");
  });
});

describe("delete rules: only the retention purge removes dependent records", () => {
  it("refuses to delete a reservation, reserved room or payment that still has dependents", async () => {
    await expect(db.query("DELETE FROM bookinn.reservation WHERE res_id = 1001")).rejects.toMatchObject({ code: "23503" });
    await expect(db.query("DELETE FROM bookinn.reservation_room WHERE res_room_id = 10001")).rejects.toMatchObject({ code: "23503" }); // Extension 7001
    await expect(db.query("DELETE FROM bookinn.payment WHERE pay_id = 1004")).rejects.toMatchObject({ code: "23503" }); // receipt, charge 7001
    expect((await db.query("SELECT count(*)::int AS n FROM bookinn.reservation_room WHERE res_id = 1001")).rows[0].n).toBe(2);
  });

  it("still allows deleting a reservation that has no dependents", async () => {
    const r = await db.query<{ res_id: number }>("INSERT INTO bookinn.reservation (cus_id) VALUES (1002) RETURNING res_id");
    await db.query("DELETE FROM bookinn.reservation WHERE res_id = $1", [r.rows[0].res_id]);
  });
});

describe("double booking counts Booked and Checked-In reservations", () => {
  it("blocks a room held by a Checked-In reservation, and frees it at check-out", async () => {
    const a = await newReservation(406, "2027-01-10", "2027-01-12");
    await db.query("UPDATE bookinn.reservation_room SET actual_check_in = '2027-01-10 14:00' WHERE res_room_id = $1", [a.resRoomId]);
    await db.query("UPDATE bookinn.reservation SET booking_status = 'Checked-In' WHERE res_id = $1", [a.resId]);
    await expect(newReservation(406, "2027-01-11", "2027-01-13")).rejects.toMatchObject({ code: "23P01" });
    await db.query("UPDATE bookinn.reservation_room SET actual_check_out = '2027-01-11 10:00', check_out_date = '2027-01-11' WHERE res_room_id = $1", [
      a.resRoomId,
    ]); // early departure
    const b = await newReservation(406, "2027-01-11", "2027-01-13");
    expect(b.resId).toBeGreaterThan(a.resId);
  });

  it("keeps a checked-in room blocked past its check-out date until it is checked out", async () => {
    const a = await newReservation(205, "2027-02-01", "2027-02-03");
    await db.query("UPDATE bookinn.reservation_room SET actual_check_in = '2027-02-01 15:00' WHERE res_room_id = $1", [a.resRoomId]);
    await db.query("UPDATE bookinn.reservation SET booking_status = 'Checked-In' WHERE res_id = $1", [a.resId]);
    // On 2027-02-04 the guest has not checked out: a booking starting that day is refused.
    await expect(onDay("2027-02-04", (t) => newReservation(205, "2027-02-04", "2027-02-05", t))).rejects.toThrow(/still checked in/);
    // Back-to-back on the planned check-out date is fine while that date has not passed.
    await onDay("2027-02-02", (t) => newReservation(205, "2027-02-03", "2027-02-04", t));
  });

  it("does not count Cancelled, Completed or No-Show reservations", async () => {
    // 1003 (Cancelled) held room 406 on 2026-09-25..29; 1001 (Completed) held 205/206 in June.
    await newReservation(406, "2026-09-26", "2026-09-27");
    await newReservation(205, "2026-06-26", "2026-06-27");
  });
});

describe("reservation status rules and points", () => {
  it("Checked-In needs a checked-in room; Cancelled and No-Show need none", async () => {
    await expect(db.query("UPDATE bookinn.reservation SET booking_status = 'Checked-In' WHERE res_id = 1004")).rejects.toMatchObject({
      code: "23514", constraint: "reservation_status_rule",
    });
    const a = await newReservation(108, "2027-03-01", "2027-03-02");
    await db.query("UPDATE bookinn.reservation_room SET actual_check_in = '2027-03-01 14:00' WHERE res_room_id = $1", [a.resRoomId]);
    await db.query("UPDATE bookinn.reservation SET booking_status = 'Checked-In' WHERE res_id = $1", [a.resId]);
    await expect(db.query("UPDATE bookinn.reservation SET booking_status = 'Cancelled' WHERE res_id = $1", [a.resId])).rejects.toMatchObject({
      constraint: "reservation_status_rule",
    });
  });

  it("Completed needs no room checked in, none still expected and no Unpaid charge; points are credited once", async () => {
    // Two rooms: 206 is checked in and out; 205 is never checked in and is expected until 2027-04-05.
    const r = await db.query<{ res_id: number }>("INSERT INTO bookinn.reservation (cus_id) VALUES (1001) RETURNING res_id");
    const resId = r.rows[0].res_id;
    await db.query(
      `INSERT INTO bookinn.reservation_room (res_id, room_no, check_in_date, check_out_date, actual_check_in) VALUES
         ($1, 206, '2027-04-01', '2027-04-03', '2027-04-01 14:00'), ($1, 205, '2027-04-01', '2027-04-05', NULL)`,
      [resId],
    );
    const p = await db.query<{ pay_id: number }>(
      "INSERT INTO bookinn.payment (res_id, pay_type, pay_method, pay_date, pay_amt, pts_earn) VALUES ($1, 'Initial', 'Card', '2027-03-01', 9000, 90) RETURNING pay_id",
      [resId],
    );
    await db.query("INSERT INTO bookinn.receipt (pay_id) VALUES ($1)", [p.rows[0].pay_id]);
    await db.query("UPDATE bookinn.reservation SET booking_status = 'Checked-In' WHERE res_id = $1", [resId]);
    const complete = (day: string) => onDay(day, (t) => t.query("UPDATE bookinn.reservation SET booking_status = 'Completed' WHERE res_id = $1", [resId]));

    await expect(complete("2027-04-02")).rejects.toThrow(/still has a room checked in/);
    await db.query("UPDATE bookinn.reservation_room SET actual_check_out = '2027-04-03 11:00' WHERE res_id = $1 AND room_no = 206", [resId]);
    await expect(complete("2027-04-03")).rejects.toThrow(/still has a room expected/);
    await db.query("INSERT INTO bookinn.adjustment_charge (res_id, charge_type, charge_amt) VALUES ($1, 'Modification', 1500)", [resId]);
    await expect(complete("2027-04-06")).rejects.toThrow(/Unpaid charges/);
    await db.query("UPDATE bookinn.adjustment_charge SET pay_status = 'Voided' WHERE res_id = $1", [resId]);

    const before = await points(db, 5001);
    await complete("2027-04-06"); // room 205 never checked in and past its check-out date → ignored
    expect(await points(db, 5001)).toBe(before + 90);
    const audit = await db.query("SELECT staff_id, old_data, new_data FROM bookinn.audit_trail WHERE aff_tab = 'LOYALTY_ACC' AND rec_id = '5001' ORDER BY audit_id DESC LIMIT 1");
    expect(audit.rows[0]).toMatchObject({ staff_id: null, old_data: `TOTAL_PTS=${before}`, new_data: `TOTAL_PTS=${before + 90}` });

    // An administrator correction out of Completed takes the points back.
    await db.query("UPDATE bookinn.reservation SET booking_status = 'Checked-In' WHERE res_id = $1", [resId]);
    expect(await points(db, 5001)).toBe(before);
  });
});

describe("overdue view (FR-28): computed, not stored", () => {
  const overdue = (day: string) =>
    onDay(day, async (t) => (await t.query("SELECT res_id, booking_status::text, unpaid_charges, unpaid_amt, days_overdue FROM bookinn.overdue_reservation ORDER BY res_id")).rows);

  it("lists a reservation past its latest check-out with an Unpaid charge (1002 on 2026-11-01)", async () => {
    expect(await overdue("2026-10-11")).toEqual([]); // latest check-out is today, not before today
    const rows = await overdue("2026-11-01");
    expect(rows).toContainEqual({ res_id: 1002, booking_status: "Booked", unpaid_charges: 1, unpaid_amt: "3000.00", days_overdue: 21 });
    expect(rows.map((r) => r.res_id)).not.toContain(1001); // settled
  });

  it("lists a reservation that is still Checked-In after its latest check-out", async () => {
    const a = await newReservation(108, "2027-05-01", "2027-05-02");
    await db.query("UPDATE bookinn.reservation_room SET actual_check_in = '2027-05-01 14:00' WHERE res_room_id = $1", [a.resRoomId]);
    await db.query("UPDATE bookinn.reservation SET booking_status = 'Checked-In' WHERE res_id = $1", [a.resId]);
    expect((await overdue("2027-05-02")).map((r) => r.res_id)).not.toContain(a.resId);
    expect(await overdue("2027-05-03")).toContainEqual(expect.objectContaining({ res_id: a.resId, booking_status: "Checked-In", unpaid_charges: 0 }));
  });
});
