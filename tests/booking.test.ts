/**
 * Reservation + payment rules (SRS §3.3). Numbers refer to the required test
 * cases in the implementation brief (see docs/REQUIREMENTS_CHECKLIST.md).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/types";
import { cancelReservation, createBooking, quoteBooking, type BookingInput } from "@/lib/booking";
import { createRow, getRow, updateRow } from "@/lib/crud";
import { amountDue, pointsEarned, pointsFor, toCents } from "@/lib/money";
import { ADMIN, FRONT_DESK, TODAY, auditFor, count, freshDb, points } from "./helpers";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await freshDb()));
afterAll(() => close());

const stay = (room_no: string, check_in_date: string, check_out_date: string) => ({ room_no, check_in_date, check_out_date });

/** Prices the booking first, then pays exactly the amount due (the normal Front Desk flow). */
async function book(input: Omit<BookingInput, "pay_amt" | "pay_method"> & { pay_method?: string }) {
  const q = await quoteBooking(db, FRONT_DESK, input, TODAY);
  const amt = `${Math.floor(q.dueCents / 100)}.${String(q.dueCents % 100).padStart(2, "0")}`;
  return createBooking(db, FRONT_DESK, { pay_method: "Cash", ...input, pay_amt: amt }, TODAY);
}

describe("creating reservations", () => {
  it("1. persists a valid reservation with its rooms, full payment, receipt and points", async () => {
    const before = await points(db, 5002);
    const b = await book({ cus_id: "1002", discount_type: "NONE", stays: [stay("205", "2027-01-10", "2027-01-12")] });
    expect(await getRow(db, FRONT_DESK, "reservation", b.resId)).toMatchObject({ booking_status: "Booked", cus_id: 1002 });
    expect(await count(db, "reservation_room", "res_id = $1", [b.resId])).toBe(1);
    expect(await getRow(db, FRONT_DESK, "payment", b.payId)).toMatchObject({
      res_id: b.resId, pay_amt: "3000.00", pay_date: TODAY, pts_earn: 60, pts_spend: 0, discount_type: "NONE",
    });
    expect(await getRow(db, FRONT_DESK, "receipt", b.rctNo)).toMatchObject({ pay_id: b.payId });
    expect(await points(db, 5002)).toBe(before + 60);
  });

  it("2. rejects a reservation without an existing customer", async () => {
    const stays = [stay("406", "2027-01-10", "2027-01-11")];
    await expect(quoteBooking(db, FRONT_DESK, { cus_id: "", discount_type: "NONE", stays }, TODAY)).rejects.toMatchObject({
      code: "validation", fieldErrors: { cus_id: expect.any(String) },
    });
    await expect(
      createBooking(db, FRONT_DESK, { cus_id: "9999", discount_type: "NONE", stays, pay_method: "Cash", pay_amt: "1500" }, TODAY),
    ).rejects.toMatchObject({ code: "validation", message: expect.stringContaining("existing customer") });
  });

  it("3. rejects check-out on or before check-in", async () => {
    for (const out of ["2027-01-10", "2027-01-09"])
      await expect(
        quoteBooking(db, FRONT_DESK, { cus_id: "1001", discount_type: "NONE", stays: [stay("406", "2027-01-10", out)] }, TODAY),
      ).rejects.toMatchObject({ code: "validation", fieldErrors: { check_out_date: expect.any(String) } });
  });

  it("4. rejects a reservation starting in the past, allows check-in today", async () => {
    await expect(
      quoteBooking(db, FRONT_DESK, { cus_id: "1001", discount_type: "NONE", stays: [stay("406", "2026-10-31", "2026-11-02")] }, TODAY),
    ).rejects.toMatchObject({ code: "validation", message: expect.stringContaining("past") });
    const q = await quoteBooking(db, FRONT_DESK, { cus_id: "1001", discount_type: "NONE", stays: [stay("406", TODAY, "2026-11-02")] }, TODAY);
    expect(q.dueCents).toBe(150_000);
  });

  it("supports several rooms in one reservation, and rejects the same room twice", async () => {
    const q = await quoteBooking(
      db, FRONT_DESK,
      { cus_id: "1001", discount_type: "NONE", stays: [stay("206", "2027-02-01", "2027-02-03"), stay("108", "2027-02-01", "2027-02-03")] },
      TODAY,
    );
    expect(q.lines).toHaveLength(2);
    expect(q.totalCents).toBe(2 * 150_000 + 2 * 300_000);
    await expect(
      quoteBooking(db, FRONT_DESK, { cus_id: "1001", discount_type: "NONE", stays: [stay("206", "2027-02-01", "2027-02-03"), stay("206", "2027-02-02", "2027-02-04")] }, TODAY),
    ).rejects.toMatchObject({ code: "validation" });
  });
});

describe("room availability and double booking", () => {
  it("5. rejects an overlapping booking for the same room; back-to-back stays are allowed", async () => {
    await expect(
      book({ cus_id: "1001", discount_type: "NONE", stays: [stay("205", "2027-01-11", "2027-01-13")] }),
    ).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("Room 205 is already booked") });
    const next = await book({ cus_id: "1001", discount_type: "NONE", stays: [stay("205", "2027-01-12", "2027-01-14")] });
    expect(next.resId).toBeTruthy();
  });

  it("6. two simultaneous conflicting bookings cannot both succeed", async () => {
    const input = { cus_id: "1001", discount_type: "NONE", stays: [stay("406", "2027-03-01", "2027-03-03")], pay_method: "Cash", pay_amt: "3000" };
    const results = await Promise.allSettled([
      createBooking(db, FRONT_DESK, input, TODAY),
      createBooking(db, { ...FRONT_DESK }, { ...input, cus_id: "1002" }, TODAY),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await count(db, "reservation_room", "room_no = 406 AND check_in_date = '2027-03-01'")).toBe(1);
  });

  it("6b. the database itself rejects a double booking that bypasses the application", async () => {
    const r = await db.query<{ res_id: number }>("INSERT INTO bookinn.reservation (cus_id) VALUES (1002) RETURNING res_id");
    await expect(
      db.query("INSERT INTO bookinn.reservation_room (res_id, room_no, check_in_date, check_out_date) VALUES ($1, 406, '2027-03-02', '2027-03-04')", [
        r.rows[0].res_id,
      ]),
    ).rejects.toMatchObject({ code: "23P01" });
  });

  it("7. a cancelled reservation releases its dates", async () => {
    const b = await book({ cus_id: "1001", discount_type: "NONE", stays: [stay("108", "2027-04-01", "2027-04-03")] });
    await expect(book({ cus_id: "1002", discount_type: "NONE", stays: [stay("108", "2027-04-02", "2027-04-03")] })).rejects.toMatchObject({
      code: "conflict",
    });
    await cancelReservation(db, FRONT_DESK, b.resId, TODAY);
    expect((await getRow(db, FRONT_DESK, "reservation", b.resId)).booking_status).toBe("Cancelled");
    const again = await book({ cus_id: "1002", discount_type: "NONE", stays: [stay("108", "2027-04-02", "2027-04-03")] });
    expect(again.resId).toBeTruthy();
  });

  it("8. a Completed reservation does not block availability", async () => {
    const b = await book({ cus_id: "1001", discount_type: "NONE", stays: [stay("206", "2027-05-01", "2027-05-02")] });
    await updateRow(db, ADMIN, "reservation", b.resId, { cus_id: "1001", booking_status: "Completed" });
    const other = await book({ cus_id: "1002", discount_type: "NONE", stays: [stay("206", "2027-05-01", "2027-05-02")] });
    expect(other.resId).toBeTruthy();
  });
});

describe("payments and receipts", () => {
  it("9. a payment smaller or greater than the amount due is rejected and nothing is saved", async () => {
    const stays = [stay("205", "2027-06-01", "2027-06-03")]; // 2 × 1500
    const before = await count(db, "reservation");
    for (const pay_amt of ["2999.99", "3000.01", "0"])
      await expect(
        createBooking(db, FRONT_DESK, { cus_id: "1002", discount_type: "NONE", stays, pay_method: "Card", pay_amt }, TODAY),
      ).rejects.toMatchObject({ code: "validation", fieldErrors: { pay_amt: expect.stringContaining("3,000.00") } });
    expect(await count(db, "reservation")).toBe(before);
    expect(await count(db, "reservation_room", "room_no = 205 AND check_in_date = '2027-06-01'")).toBe(0);
  });

  it("10. a second payment for the same reservation is rejected", async () => {
    await expect(
      createRow(db, ADMIN, "payment", { res_id: "1004", pay_method: "Cash", pay_date: TODAY, pay_amt: "3000", discount_type: "NONE" }, TODAY),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      db.query("INSERT INTO bookinn.payment (res_id, pay_method, pay_date, pay_amt) VALUES (1004, 'Cash', '2026-11-01', 3000)"),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("11. each receipt is linked to exactly one valid payment", async () => {
    expect(await count(db, "receipt", "pay_id = 1004")).toBe(1);
    await expect(createRow(db, ADMIN, "receipt", { pay_id: "1004" })).rejects.toMatchObject({ code: "conflict" });
    await expect(createRow(db, ADMIN, "receipt", { pay_id: "999999" })).rejects.toMatchObject({ code: "dependency" });
    const orphan = await db.query("SELECT p.pay_id FROM bookinn.payment p LEFT JOIN bookinn.receipt r ON r.pay_id = p.pay_id WHERE r.rct_no IS NULL");
    expect(orphan.rows).toEqual([]);
  });
});

describe("loyalty points and discounts", () => {
  it("12. points earned = payment ÷ 50, decimals discarded", async () => {
    expect(pointsEarned(toCents("3000"))).toBe(60);
    expect(pointsEarned(toCents("149.99"))).toBe(2);
    expect(pointsEarned(toCents("49.99"))).toBe(0);
    const before = await points(db, 5001);
    const b = await book({ cus_id: "1001", discount_type: "NONE", stays: [stay("406", "2027-07-01", "2027-07-04")] }); // 4500
    expect((await getRow(db, FRONT_DESK, "payment", b.payId)).pts_earn).toBe(90);
    expect(await points(db, 5001)).toBe(before + 90);
  });

  it("guests without a loyalty account earn nothing", async () => {
    const cus = await createRow(db, FRONT_DESK, "customer", { cus_name: "No Account", cus_email: "noacct@example.com", cus_mobile: "09170000002" });
    const b = await book({ cus_id: String(cus.cus_id), discount_type: "NONE", stays: [stay("406", "2027-07-10", "2027-07-11")] });
    expect((await getRow(db, FRONT_DESK, "payment", b.payId)).pts_earn).toBe(0);
  });

  it("13. a payment cannot earn and spend points at the same time", async () => {
    expect(pointsFor(toCents("5280"), "12% Discount", true)).toEqual({ spend: 100, earn: 0 });
    const b = await book({ cus_id: "1001", discount_type: "12% Discount", stays: [stay("205", "2027-08-01", "2027-08-03")] });
    expect(await getRow(db, FRONT_DESK, "payment", b.payId)).toMatchObject({ pts_spend: 100, pts_earn: 0, pay_amt: "2640.00" });
    await expect(
      db.query("UPDATE bookinn.payment SET pts_earn = 10 WHERE pay_id = $1", [b.payId]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("14. insufficient points (or no account) prevent redemption", async () => {
    const cus = await createRow(db, FRONT_DESK, "customer", { cus_name: "New Member", cus_email: "member@example.com", cus_mobile: "09170000003" });
    const stays = [stay("406", "2027-09-01", "2027-09-02")];
    await expect(quoteBooking(db, FRONT_DESK, { cus_id: String(cus.cus_id), discount_type: "12% Discount", stays }, TODAY)).rejects.toMatchObject({
      fieldErrors: { discount_type: "No loyalty account." },
    });
    await createRow(db, FRONT_DESK, "loyalty_acc", { cus_id: String(cus.cus_id) });
    await expect(quoteBooking(db, FRONT_DESK, { cus_id: String(cus.cus_id), discount_type: "Free Night", stays }, TODAY)).rejects.toMatchObject({
      fieldErrors: { discount_type: "Not enough points." },
    });
  });

  it("15. 12% and free-night discounts produce the correct totals", async () => {
    expect(amountDue(900_000, 300_000, "12% Discount")).toBe(792_000);
    expect(amountDue(900_000, 300_000, "Free Night")).toBe(600_000);
    expect(amountDue(12_345, 12_345, "12% Discount")).toBe(12_345 - 1481); // 12% of 123.45 = 14.81 (half-up)
    const stays = [stay("205", "2027-10-01", "2027-10-03"), stay("108", "2027-10-01", "2027-10-03")]; // 3000 + 6000
    const twelve = await quoteBooking(db, FRONT_DESK, { cus_id: "1001", discount_type: "12% Discount", stays }, TODAY);
    expect(twelve).toMatchObject({ totalCents: 900_000, discountCents: 108_000, dueCents: 792_000, pointsSpend: 100, pointsEarn: 0 });
    const free = await quoteBooking(db, FRONT_DESK, { cus_id: "1001", discount_type: "Free Night", stays }, TODAY);
    expect(free).toMatchObject({ dueCents: 600_000, discountCents: 300_000, pointsSpend: 250 }); // most expensive room, one night
  });

  it("16. a free night on a one-room, one-night stay is recorded as a ₱0 payment with a receipt", async () => {
    const before = await points(db, 5001);
    const b = await book({ cus_id: "1001", discount_type: "Free Night", stays: [stay("406", "2027-11-01", "2027-11-02")] });
    expect(await getRow(db, FRONT_DESK, "payment", b.payId)).toMatchObject({ pay_amt: "0.00", pts_spend: 250, pts_earn: 0 });
    expect(await count(db, "receipt", "pay_id = $1", [b.payId])).toBe(1);
    expect(await points(db, 5001)).toBe(before - 250);
  });

  it("17. cancelling keeps the payment and the points already earned or spent (no refund)", async () => {
    const b = await book({ cus_id: "1002", discount_type: "NONE", stays: [stay("205", "2027-12-01", "2027-12-02")] });
    const pts = await points(db, 5002);
    await cancelReservation(db, FRONT_DESK, b.resId, TODAY);
    expect(await getRow(db, FRONT_DESK, "payment", b.payId)).toMatchObject({ pay_amt: "1500.00", pts_earn: 30 });
    expect(await points(db, 5002)).toBe(pts);
    expect(await count(db, "cancellation", "res_id = $1", [b.resId])).toBe(1);
    await expect(cancelReservation(db, FRONT_DESK, b.resId, TODAY)).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("logged reservations are locked", () => {
  it("21. ordinary users cannot edit a confirmed reservation; administrator corrections are audited", async () => {
    await expect(updateRow(db, FRONT_DESK, "reservation_room", 10005, { room_no: "205", check_in_date: "2026-12-20", check_out_date: "2026-12-23" }))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(updateRow(db, FRONT_DESK, "payment", 1004, { pay_method: "Card", pay_date: "2026-10-20", pay_amt: "3000", discount_type: "NONE" }))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(updateRow(db, FRONT_DESK, "reservation", 1004, { cus_id: "1002", booking_status: "Booked" }))
      .rejects.toMatchObject({ code: "forbidden" });

    await updateRow(db, ADMIN, "payment", 1004, { pay_method: "Card", pay_date: "2026-10-20", pay_amt: "3000", discount_type: "NONE" });
    const audit = await auditFor(db, "PAYMENT", 1004);
    expect(audit.at(-1)).toMatchObject({ action: "UPDATE", staff_id: 1003, old_data: "PAY_METHOD=Cash", new_data: "PAY_METHOD=Card" });
  });

  it("an administrator correction that changes the discount adjusts the points once", async () => {
    const before = await points(db, 5001);
    await updateRow(db, ADMIN, "payment", 1004, { pay_method: "Card", pay_date: "2026-10-20", pay_amt: "2640", discount_type: "12% Discount" });
    expect(await getRow(db, ADMIN, "payment", 1004)).toMatchObject({ pts_earn: 0, pts_spend: 100 });
    expect(await points(db, 5001)).toBe(before - 60 - 100);
  });
});
