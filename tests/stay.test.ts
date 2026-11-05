/**
 * SRS v2 business logic, end to end through src/lib: booking, modification,
 * check-in, extension, check-out, Checkout payment / Checkout Credit,
 * cancellation with refund, points, and the Completed rule.
 *
 * The first three suites replay the SRS sample reservations 1001, 1002 and
 * 1003 (§4.2 Tables 9–17) and must produce the same rows and points. They use
 * copies of the sample rooms (207/208 = RT01 like 205/206, 109 = RT02 like
 * 108, 407 = RT01 like 406) so the seeded sample rows do not get in the way.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/types";
import { cancelReservation, createBooking, quoteBooking, type BookingInput } from "@/lib/booking";
import { createRow } from "@/lib/crud";
import { modifyReservation } from "@/lib/modify";
import { checkInRoom, checkOutRoom, extendStay, settleCheckout } from "@/lib/stay";
import { runMaintenance } from "@/lib/maintenance";
import { atHotelTime, beforeCutoff, cutoffFor, hotelNow } from "@/lib/dates";
import { ADMIN, FINANCE, FRONT_DESK, freshDb, points } from "./helpers";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await freshDb());
  await db.query("INSERT INTO bookinn.room (room_no, room_type_id) VALUES (207, 'RT01'), (208, 'RT01'), (109, 'RT02'), (407, 'RT01'), (408, 'RT01')");
});
afterAll(() => close());

const at = (local: string) => atHotelTime(local);
const stay = (room_no: string, check_in_date: string, check_out_date: string) => ({ room_no, check_in_date, check_out_date });

/** A new guest with a loyalty account holding `pts` points. */
async function guest(name: string, pts = 0) {
  const c = await createRow(db, FRONT_DESK, "customer", {
    cus_name: name,
    cus_email: `${name.toLowerCase().replace(/\W/g, "")}@example.com`,
    cus_mobile: "09170000000",
  });
  const l = await createRow(db, FRONT_DESK, "loyalty_acc", { cus_id: String(c.cus_id) });
  if (pts) await db.query("UPDATE bookinn.loyalty_acc SET total_pts = $2 WHERE lyl_id = $1", [l.lyl_id, pts]);
  return { cusId: String(c.cus_id), lylId: Number(l.lyl_id) };
}

/** Books on `day` and pays exactly the amount due. */
async function book(input: Omit<BookingInput, "pay_amt" | "pay_method">, day: string, method = "Cash") {
  const q = await quoteBooking(db, FRONT_DESK, input, day);
  return createBooking(db, FRONT_DESK, { ...input, pay_method: method, pay_amt: (q.dueCents / 100).toFixed(2) }, day);
}

const rows = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows;
const status = async (resId: number) => (await rows("SELECT booking_status::text AS s FROM bookinn.reservation WHERE res_id = $1", [resId]))[0].s;
const roomRow = async (resId: number, roomNo: number) =>
  (await rows("SELECT res_room_id, check_out_date FROM bookinn.reservation_room WHERE res_id = $1 AND room_no = $2", [resId, roomNo]))[0] as {
    res_room_id: number;
    check_out_date: string;
  };

describe("SRS sample reservation 1001: two rooms, an extension, one Checkout payment, Completed", () => {
  it("produces the rows of Tables 10, 13, 14 and 16 and 60 + 15 = 75 points", async () => {
    const g = await guest("Sample One");
    // 06-20: two Standard rooms, 06-25 → 06-27, paid upfront 6,000 by Digital Wallet.
    const b = await book({ cus_id: g.cusId, discount_type: "NONE", stays: [stay("207", "2026-06-25", "2026-06-27"), stay("208", "2026-06-25", "2026-06-27")] }, "2026-06-20", "Digital Wallet");
    expect(b.quote).toMatchObject({ dueCents: 600_000, pointsEarn: 60, pointsSpend: 0 });
    expect(await points(db, g.lylId)).toBe(0); // earned points wait for Completed

    const r207 = await roomRow(b.resId, 207);
    const r208 = await roomRow(b.resId, 208);
    await checkInRoom(db, FRONT_DESK, r207.res_room_id, at("2026-06-25 14:10:00"));
    await checkInRoom(db, FRONT_DESK, r208.res_room_id, at("2026-06-25 14:10:00"));
    expect(await status(b.resId)).toBe("Checked-In");

    // 06-26 14:05: room 207 is extended in place by one night (Table 16, charge 7001).
    const ext = await extendStay(db, FRONT_DESK, r207.res_room_id, "2026-06-28", {}, at("2026-06-26 14:05:00"));
    expect(ext).toMatchObject({ inPlace: true, extFrom: "2026-06-27", extTo: "2026-06-28", amountCents: 150_000 });

    const out208 = await checkOutRoom(db, FRONT_DESK, r208.res_room_id, at("2026-06-27 11:30:00"));
    expect(out208).toMatchObject({ earlyDeparture: false, lastRoom: false, completed: false });
    const out207 = await checkOutRoom(db, FRONT_DESK, r207.res_room_id, at("2026-06-28 11:40:00"));
    expect(out207).toMatchObject({ lastRoom: true, dueCents: 150_000, unpaidCount: 1, completed: false });

    // The guest pays the Unpaid charges in one Checkout payment (Table 13, payment 1004).
    await expect(settleCheckout(db, FRONT_DESK, b.resId, { pay_method: "Cash", pay_amt: "1499.99" }, at("2026-06-28 11:41:00"))).rejects.toMatchObject({
      code: "validation",
    });
    const s = await settleCheckout(db, FRONT_DESK, b.resId, { pay_method: "Cash", pay_amt: "1500" }, at("2026-06-28 11:42:00"));
    expect(s).toMatchObject({ amountCents: 150_000, pointsEarned: 15, refundId: null, completed: true });
    expect(s.rctNo).toBeTruthy();

    expect(await rows("SELECT pay_type::text, pay_method::text, pay_date, pay_amt, pts_earn, discount_type::text FROM bookinn.payment WHERE res_id = $1 ORDER BY pay_id", [b.resId])).toEqual([
      { pay_type: "Initial", pay_method: "Digital Wallet", pay_date: "2026-06-20", pay_amt: "6000.00", pts_earn: 60, discount_type: "NONE" },
      { pay_type: "Checkout", pay_method: "Cash", pay_date: "2026-06-28", pay_amt: "1500.00", pts_earn: 15, discount_type: "NONE" },
    ]);
    expect(await rows("SELECT charge_type::text, ext_from, ext_to, charge_amt, pay_status::text, pay_id FROM bookinn.adjustment_charge WHERE res_id = $1", [b.resId])).toEqual([
      { charge_type: "Extension", ext_from: "2026-06-27", ext_to: "2026-06-28", charge_amt: "1500.00", pay_status: "Paid", pay_id: s.payId },
    ]);
    expect(
      await rows(
        `SELECT room_no, check_in_date, check_out_date, to_char(actual_check_in, 'YYYY-MM-DD HH24:MI') AS ain, to_char(actual_check_out, 'YYYY-MM-DD HH24:MI') AS aout
           FROM bookinn.reservation_room WHERE res_id = $1 ORDER BY room_no`,
        [b.resId],
      ),
    ).toEqual([
      { room_no: 207, check_in_date: "2026-06-25", check_out_date: "2026-06-28", ain: "2026-06-25 14:10", aout: "2026-06-28 11:40" },
      { room_no: 208, check_in_date: "2026-06-25", check_out_date: "2026-06-27", ain: "2026-06-25 14:10", aout: "2026-06-27 11:30" },
    ]);
    expect(await status(b.resId)).toBe("Completed");
    expect(await points(db, g.lylId)).toBe(75); // Table 8: 60 + 15, credited at Completed
  });
});

describe("SRS sample reservation 1002: 12% discount, then an edit posted as a Modification charge", () => {
  let resId = 0;
  let lylId = 0;

  it("books 2 Deluxe nights for 6,000 − 12% = 5,280 with 100 points, then posts +3,000 when check-out moves to 10-11", async () => {
    const g = await guest("Sample Two", 350);
    lylId = g.lylId;
    const b = await book({ cus_id: g.cusId, discount_type: "12% Discount", stays: [stay("109", "2026-10-08", "2026-10-10")] }, "2026-08-07");
    resId = b.resId;
    expect(b.quote).toMatchObject({ totalCents: 600_000, dueCents: 528_000, pointsSpend: 100, pointsEarn: 0 });
    expect(await points(db, lylId)).toBe(250); // Table 8: spent points deducted at payment

    const row = await roomRow(resId, 109);
    const m = await modifyReservation(db, FRONT_DESK, resId, [{ res_room_id: row.res_room_id, room_no: "109", check_in_date: "2026-10-08", check_out_date: "2026-10-11" }], at("2026-08-07 10:20:00"));
    expect(m).toMatchObject({ changed: [row.res_room_id], differenceCents: 300_000 });
    expect(await rows("SELECT res_room_id, charge_type::text, ext_from, charge_amt, pay_status::text, pay_id FROM bookinn.adjustment_charge WHERE res_id = $1", [resId])).toEqual([
      { res_room_id: null, charge_type: "Modification", ext_from: null, charge_amt: "3000.00", pay_status: "Unpaid", pay_id: null },
    ]); // Table 16, charge 7002: no loyalty discount on the charge
    expect(await status(resId)).toBe("Booked");
  });

  it("closes edits at the 48-hour cutoff (earliest check-in 14:00 minus 48 hours; exactly at the cutoff is on time)", async () => {
    expect(cutoffFor("2026-10-08")).toBe("2026-10-06 14:00:00");
    const row = await roomRow(resId, 109);
    const edit = (when: string, out: string) =>
      modifyReservation(db, FRONT_DESK, resId, [{ res_room_id: row.res_room_id, room_no: "109", check_in_date: "2026-10-08", check_out_date: out }], at(when));
    await expect(edit("2026-10-06 14:00:01", "2026-10-12")).rejects.toThrow(/48 hours/);
    // Exactly at the cutoff the edit passes the cutoff check (it is then refused only because nothing changed).
    await expect(edit("2026-10-06 14:00:00", "2026-10-11")).rejects.toThrow(/Nothing was changed/);
  });

  it("settles the charge at check-out in one Checkout payment and credits the points it earns", async () => {
    const row = await roomRow(resId, 109);
    await expect(checkInRoom(db, FRONT_DESK, row.res_room_id, at("2026-10-07 20:00:00"))).rejects.toThrow(/before its check-in date/);
    await checkInRoom(db, FRONT_DESK, row.res_room_id, at("2026-10-08 15:00:00"));
    await expect(modifyReservation(db, FRONT_DESK, resId, [{ res_room_id: row.res_room_id, room_no: "109", check_in_date: "2026-10-08", check_out_date: "2026-10-12" }], at("2026-10-08 16:00:00"))).rejects.toThrow(
      /Only Booked/,
    );
    const out = await checkOutRoom(db, FRONT_DESK, row.res_room_id, at("2026-10-11 11:00:00"));
    expect(out).toMatchObject({ lastRoom: true, dueCents: 300_000 });
    const s = await settleCheckout(db, FRONT_DESK, resId, { pay_method: "Card", pay_amt: "3000.00" }, at("2026-10-11 11:05:00"));
    expect(s).toMatchObject({ pointsEarned: 30, completed: true });
    expect(await points(db, lylId)).toBe(280); // 250 + 0 (Initial used a discount) + 30
  });
});

describe("SRS sample reservation 1003: cancelled 10 days before check-in", () => {
  it("refunds the 6,000 paid in full (Table 17), records the cancellation (Table 15), and never credits the 60 points", async () => {
    const g = await guest("Sample Three");
    const b = await book({ cus_id: g.cusId, discount_type: "NONE", stays: [stay("407", "2026-09-25", "2026-09-29")] }, "2026-09-11", "Digital Wallet");
    expect(b.quote).toMatchObject({ dueCents: 600_000, pointsEarn: 60 });
    const c = await cancelReservation(db, FRONT_DESK, b.resId, at("2026-09-15 09:17:00"));
    expect(c).toMatchObject({ onTime: true, refundCents: 600_000, pointsReturned: 0 });
    expect(await rows("SELECT refund_type::text, refund_amt, refund_date FROM bookinn.refund WHERE res_id = $1", [b.resId])).toEqual([
      { refund_type: "Cancellation", refund_amt: "6000.00", refund_date: "2026-09-15" },
    ]);
    expect(await rows("SELECT cancel_date FROM bookinn.cancellation WHERE res_id = $1", [b.resId])).toEqual([{ cancel_date: "2026-09-15" }]);
    expect(await status(b.resId)).toBe("Cancelled");
    expect(await points(db, g.lylId)).toBe(0);
    // The room is free again for those dates.
    expect((await book({ cus_id: g.cusId, discount_type: "NONE", stays: [stay("407", "2026-09-26", "2026-09-27")] }, "2026-09-15")).resId).toBeGreaterThan(b.resId);
  });
});

describe("cancellation rules (FR-27, §3.3 Cancellations)", () => {
  it("refunds exactly at the cutoff, refunds nothing one second later, and returns spent points either way", async () => {
    expect(beforeCutoff("2027-01-08 14:00:00", "2027-01-10")).toBe(true);
    expect(beforeCutoff("2027-01-08 14:00:01", "2027-01-10")).toBe(false);
    const g = await guest("Late Canceller", 500);
    const onTime = await book({ cus_id: g.cusId, discount_type: "12% Discount", stays: [stay("407", "2027-01-10", "2027-01-11")] }, "2027-01-01");
    const late = await book({ cus_id: g.cusId, discount_type: "Free Night", stays: [stay("408", "2027-01-10", "2027-01-12")] }, "2027-01-01");
    expect(await points(db, g.lylId)).toBe(500 - 100 - 250);

    const a = await cancelReservation(db, FRONT_DESK, onTime.resId, at("2027-01-08 14:00:00"));
    expect(a).toMatchObject({ onTime: true, refundCents: 132_000, pointsReturned: 100 }); // 1500 − 12%
    const b = await cancelReservation(db, FRONT_DESK, late.resId, at("2027-01-08 14:00:01"));
    expect(b).toMatchObject({ onTime: false, refundId: null, refundCents: 0, pointsReturned: 250 });
    expect(await rows("SELECT count(*)::int AS n FROM bookinn.refund WHERE res_id = $1", [late.resId])).toEqual([{ n: 0 }]);
    expect(await points(db, g.lylId)).toBe(500);
  });

  it("uses the earliest check-in of a multi-room reservation and voids an Unpaid edit charge (only the paid amount is refunded)", async () => {
    const g = await guest("Two Rooms");
    const b = await book({ cus_id: g.cusId, discount_type: "NONE", stays: [stay("207", "2027-02-10", "2027-02-11"), stay("208", "2027-02-12", "2027-02-13")] }, "2027-02-01");
    const rr = await rows("SELECT res_room_id, room_no FROM bookinn.reservation_room WHERE res_id = $1 ORDER BY room_no", [b.resId]);
    await modifyReservation(
      db, FRONT_DESK, b.resId,
      [
        { res_room_id: rr[0].res_room_id as number, room_no: "207", check_in_date: "2027-02-10", check_out_date: "2027-02-11" },
        { res_room_id: rr[1].res_room_id as number, room_no: "208", check_in_date: "2027-02-12", check_out_date: "2027-02-14" },
      ],
      at("2027-02-02 09:00:00"),
    );
    // 2027-02-09 10:00 is more than 48 h before room 208 but inside the cutoff of room 207 (the earliest).
    const c = await cancelReservation(db, FRONT_DESK, b.resId, at("2027-02-09 10:00:00"));
    expect(c).toMatchObject({ onTime: false, refundCents: 0, voidedChargeIds: [expect.any(Number)] });
    expect(await rows("SELECT pay_status::text AS s FROM bookinn.adjustment_charge WHERE res_id = $1", [b.resId])).toEqual([{ s: "Voided" }]);
  });

  it("is refused once a room has been checked in, and for Finance", async () => {
    const g = await guest("Checked In Guest");
    const b = await book({ cus_id: g.cusId, discount_type: "NONE", stays: [stay("407", "2027-03-01", "2027-03-02")] }, "2027-02-20");
    await expect(cancelReservation(db, FINANCE, b.resId, at("2027-02-21 09:00:00"))).rejects.toMatchObject({ code: "forbidden" });
    await checkInRoom(db, FRONT_DESK, (await roomRow(b.resId, 407)).res_room_id, at("2027-03-01 14:00:00"));
    await expect(cancelReservation(db, FRONT_DESK, b.resId, at("2027-03-01 15:00:00"))).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("modification pricing (§3.3 Modification Pricing)", () => {
  it("re-prices only changed rows as a whole: room changes, added and removed rooms, and a negative charge", async () => {
    const g = await guest("Editor");
    const b = await book({ cus_id: g.cusId, discount_type: "NONE", stays: [stay("207", "2027-04-10", "2027-04-12"), stay("208", "2027-04-10", "2027-04-12")] }, "2027-04-01");
    const r = await rows("SELECT res_room_id, room_no FROM bookinn.reservation_room WHERE res_id = $1 ORDER BY room_no", [b.resId]);
    const [r207, r208] = r.map((x) => Number(x.res_room_id));
    const edit = (s: Parameters<typeof modifyReservation>[3], when = "2027-04-02 09:00:00") => modifyReservation(db, FRONT_DESK, b.resId, s, at(when));

    // 207 → Deluxe 109 for the same 2 nights: 2 × 3000 − 2 × 1500 = +3000; 208 unchanged and not re-priced.
    expect(
      (await edit([{ res_room_id: r207, room_no: "109", check_in_date: "2027-04-10", check_out_date: "2027-04-12" }, { res_room_id: r208, room_no: "208", check_in_date: "2027-04-10", check_out_date: "2027-04-12" }]))
        .differenceCents,
    ).toBe(300_000);
    // Remove 208 (−3000) and add 407 for one night (+1500): −1500.
    const m = await edit([{ res_room_id: r207, room_no: "109", check_in_date: "2027-04-10", check_out_date: "2027-04-12" }, { room_no: "407", check_in_date: "2027-04-11", check_out_date: "2027-04-12" }]);
    expect(m).toMatchObject({ removed: [r208], added: [expect.any(Number)], differenceCents: -150_000 });
    expect(await rows("SELECT charge_amt, pay_status::text FROM bookinn.adjustment_charge WHERE res_id = $1 ORDER BY charge_id", [b.resId])).toEqual([
      { charge_amt: "3000.00", pay_status: "Unpaid" },
      { charge_amt: "-1500.00", pay_status: "Unpaid" },
    ]);
  });

  it("passes the same overlap check as a new booking and keeps the booking rules", async () => {
    const g = await guest("Blocked Editor");
    const a = await book({ cus_id: g.cusId, discount_type: "NONE", stays: [stay("408", "2027-05-10", "2027-05-12")] }, "2027-05-01");
    const b = await book({ cus_id: g.cusId, discount_type: "NONE", stays: [stay("407", "2027-05-10", "2027-05-12")] }, "2027-05-01");
    const rb = (await roomRow(b.resId, 407)).res_room_id;
    const edit = (s: Parameters<typeof modifyReservation>[3]) => modifyReservation(db, FRONT_DESK, b.resId, s, at("2027-05-02 09:00:00"));
    await expect(edit([{ res_room_id: rb, room_no: "408", check_in_date: "2027-05-11", check_out_date: "2027-05-13" }])).rejects.toMatchObject({ code: "conflict" }); // held by a
    await expect(edit([])).rejects.toThrow(/at least one room/);
    await expect(edit([{ res_room_id: rb, room_no: "407", check_in_date: "2027-05-01", check_out_date: "2027-05-03" }])).rejects.toThrow(/past|cutoff/);
    await expect(edit([{ res_room_id: (await roomRow(a.resId, 408)).res_room_id, room_no: "408", check_in_date: "2027-05-10", check_out_date: "2027-05-13" }])).rejects.toThrow(/not part of/);
    // Moving its own dates over itself is fine (its own rows are left out of the check).
    expect((await edit([{ res_room_id: rb, room_no: "407", check_in_date: "2027-05-11", check_out_date: "2027-05-13" }])).differenceCents).toBe(0);
  });
});

describe("extension, early departure and Checkout Credit", () => {
  it("extends only while Checked-In, offers another room when the same room is taken, and stops after settlement", async () => {
    const g = await guest("Extender");
    const b = await book({ cus_id: g.cusId, discount_type: "NONE", stays: [stay("207", "2027-06-10", "2027-06-12")] }, "2027-06-01");
    const blocker = await book({ cus_id: g.cusId, discount_type: "NONE", stays: [stay("207", "2027-06-12", "2027-06-14")] }, "2027-06-01");
    const r = (await roomRow(b.resId, 207)).res_room_id;
    await expect(extendStay(db, FRONT_DESK, r, "2027-06-13", {}, at("2027-06-05 10:00:00"))).rejects.toThrow(/Only Checked-In/);
    await checkInRoom(db, FRONT_DESK, r, at("2027-06-10 14:30:00"));
    await expect(extendStay(db, FRONT_DESK, r, "2027-06-13", {}, at("2027-06-11 10:00:00"))).rejects.toMatchObject({ code: "conflict" }); // 207 is booked from 06-12
    const other = await extendStay(db, FRONT_DESK, r, "2027-06-13", { roomNo: "208" }, at("2027-06-11 10:00:00"));
    expect(other).toMatchObject({ inPlace: false, extFrom: "2027-06-12", extTo: "2027-06-13", amountCents: 150_000 });
    expect(await rows("SELECT room_no, check_in_date, check_out_date FROM bookinn.reservation_room WHERE res_room_id = $1", [other.resRoomId])).toEqual([
      { room_no: 208, check_in_date: "2027-06-12", check_out_date: "2027-06-13" },
    ]);
    expect(blocker.resId).toBeGreaterThan(b.resId);

    // The guest moves to 208 and checks out; one Checkout payment settles the extension.
    await checkOutRoom(db, FRONT_DESK, r, at("2027-06-12 11:00:00"));
    await checkInRoom(db, FRONT_DESK, other.resRoomId, at("2027-06-12 14:00:00"));
    const out = await checkOutRoom(db, FRONT_DESK, other.resRoomId, at("2027-06-13 11:00:00"));
    expect(out).toMatchObject({ lastRoom: true, dueCents: 150_000 });
    await settleCheckout(db, FRONT_DESK, b.resId, { pay_method: "Cash", pay_amt: "1500" }, at("2027-06-13 11:01:00"));
    await expect(settleCheckout(db, FRONT_DESK, b.resId, { pay_method: "Cash", pay_amt: "0" }, at("2027-06-13 11:02:00"))).rejects.toMatchObject({ code: "conflict" });
  });

  it("early departure shortens the stay and voids unused extension nights; no refund of prepaid nights", async () => {
    const g = await guest("Early Leaver");
    const b = await book({ cus_id: g.cusId, discount_type: "NONE", stays: [stay("408", "2027-07-10", "2027-07-12")] }, "2027-07-01");
    const r = (await roomRow(b.resId, 408)).res_room_id;
    await checkInRoom(db, FRONT_DESK, r, at("2027-07-10 14:00:00"));
    const ext = await extendStay(db, FRONT_DESK, r, "2027-07-14", {}, at("2027-07-11 09:00:00")); // 2 nights, 3000
    // Leaves on 07-13: one extension night used → the 3000 charge is voided and 1500 is posted for 07-12 → 07-13.
    const out = await checkOutRoom(db, FRONT_DESK, r, at("2027-07-13 08:00:00"));
    expect(out).toMatchObject({ earlyDeparture: true, checkOutDate: "2027-07-13", voidedChargeIds: [ext.chargeId], dueCents: 150_000 });
    expect(await rows("SELECT ext_from, ext_to, charge_amt, pay_status::text FROM bookinn.adjustment_charge WHERE res_id = $1 ORDER BY charge_id", [b.resId])).toEqual([
      { ext_from: "2027-07-12", ext_to: "2027-07-14", charge_amt: "3000.00", pay_status: "Voided" },
      { ext_from: "2027-07-12", ext_to: "2027-07-13", charge_amt: "1500.00", pay_status: "Unpaid" },
    ]);
    expect(await rows("SELECT count(*)::int AS n FROM bookinn.refund WHERE res_id = $1", [b.resId])).toEqual([{ n: 0 }]);

    // Leaving before the extension starts voids it entirely; with nothing Unpaid the stay completes at once.
    const g2 = await guest("Earlier Leaver");
    const b2 = await book({ cus_id: g2.cusId, discount_type: "NONE", stays: [stay("408", "2027-08-10", "2027-08-13")] }, "2027-08-01");
    const r2 = (await roomRow(b2.resId, 408)).res_room_id;
    await checkInRoom(db, FRONT_DESK, r2, at("2027-08-10 14:00:00"));
    await extendStay(db, FRONT_DESK, r2, "2027-08-14", {}, at("2027-08-10 15:00:00"));
    const out2 = await checkOutRoom(db, FRONT_DESK, r2, at("2027-08-11 07:00:00"));
    expect(out2).toMatchObject({ earlyDeparture: true, checkOutDate: "2027-08-11", repostedChargeId: null, dueCents: 0, completed: true });
    expect(await points(db, g2.lylId)).toBe(45); // 4500 ÷ 100, credited at Completed
  });

  it("records a Checkout Credit refund when the charges add up to less than zero", async () => {
    const g = await guest("Credit Guest");
    const b = await book({ cus_id: g.cusId, discount_type: "NONE", stays: [stay("109", "2027-09-10", "2027-09-13")] }, "2027-09-01");
    const r = (await roomRow(b.resId, 109)).res_room_id;
    await modifyReservation(db, FRONT_DESK, b.resId, [{ res_room_id: r, room_no: "109", check_in_date: "2027-09-10", check_out_date: "2027-09-12" }], at("2027-09-02 09:00:00")); // −3000
    await checkInRoom(db, FRONT_DESK, r, at("2027-09-10 14:00:00"));
    expect((await checkOutRoom(db, FRONT_DESK, r, at("2027-09-12 11:00:00"))).dueCents).toBe(-300_000);
    const s = await settleCheckout(db, FRONT_DESK, b.resId, {}, at("2027-09-12 11:05:00"));
    expect(s).toMatchObject({ amountCents: -300_000, payId: null, completed: true });
    expect(await rows("SELECT refund_type::text, refund_amt FROM bookinn.refund WHERE refund_id = $1", [s.refundId])).toEqual([
      { refund_type: "Checkout Credit", refund_amt: "3000.00" },
    ]);
    expect(await rows("SELECT pay_status::text, pay_id FROM bookinn.adjustment_charge WHERE res_id = $1", [b.resId])).toEqual([{ pay_status: "Paid", pay_id: null }]);
    expect(await points(db, g.lylId)).toBe(90); // 9000 Initial ÷ 100; a credit earns nothing
  });
});

describe("Completed rule for multi-room reservations", () => {
  it("waits for a room that is still expected, then the daily job completes it and credits the points", async () => {
    const g = await guest("Staggered");
    const b = await book({ cus_id: g.cusId, discount_type: "NONE", stays: [stay("207", "2027-10-10", "2027-10-11"), stay("208", "2027-10-12", "2027-10-14")] }, "2027-10-01");
    const r207 = (await roomRow(b.resId, 207)).res_room_id;
    await checkInRoom(db, FRONT_DESK, r207, at("2027-10-10 14:00:00"));
    const out = await checkOutRoom(db, FRONT_DESK, r207, at("2027-10-11 11:00:00"));
    expect(out).toMatchObject({ lastRoom: true, unpaidCount: 0, completed: false }); // 208 still expected
    expect(await points(db, g.lylId)).toBe(0);
    expect((await runMaintenance(db, { today: "2027-10-14" })).completed).toBe(0); // 208's check-out date has not passed
    expect((await runMaintenance(db, { today: "2027-10-15" })).completed).toBeGreaterThanOrEqual(1); // 208 never checked in → ignored
    expect(await status(b.resId)).toBe("Completed");
    expect(await points(db, g.lylId)).toBe(45); // (1500 + 3000) ÷ 100
  });
});

describe("permissions and validation of the stay actions", () => {
  it("Finance cannot check in, extend, check out, settle or edit; the administrator can", async () => {
    await expect(checkInRoom(db, FINANCE, 10005)).rejects.toMatchObject({ code: "forbidden" });
    await expect(checkOutRoom(db, FINANCE, 10005)).rejects.toMatchObject({ code: "forbidden" });
    await expect(extendStay(db, FINANCE, 10005, "2026-12-23")).rejects.toMatchObject({ code: "forbidden" });
    await expect(settleCheckout(db, FINANCE, 1004)).rejects.toMatchObject({ code: "forbidden" });
    await expect(modifyReservation(db, FINANCE, 1004, [])).rejects.toMatchObject({ code: "forbidden" });
    const g = await guest("Admin Checked");
    const b = await book({ cus_id: g.cusId, discount_type: "NONE", stays: [stay("207", "2028-01-10", "2028-01-11")] }, "2028-01-01");
    const r = (await roomRow(b.resId, 207)).res_room_id;
    await expect(checkInRoom(db, ADMIN, r, at("2028-01-09 15:00:00"))).rejects.toThrow(/before its check-in date/);
    expect((await checkInRoom(db, ADMIN, r, at("2028-01-10 13:00:00"))).checkedInAt).toBe("2028-01-10 13:00:00");
  });

  it("stores check-in and check-out in Asia/Manila time", () => {
    expect(hotelNow(new Date("2026-06-25T06:10:00Z"))).toBe("2026-06-25 14:10:00");
  });
});
