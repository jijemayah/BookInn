/**
 * The stay (SRS v2 FR-20, FR-21, FR-26, §3.3 Check-in and Check-out,
 * Extension, Payments & Receipts):
 *
 *   checkInRoom     record one room's check-in (on or after its check-in date);
 *                   the reservation becomes Checked-In.
 *   extendStay      during the stay only: extend a room's check-out in place,
 *                   or add another room when the same room is not free; the
 *                   extra nights become an Unpaid Extension charge.
 *   checkOutRoom    record one room's check-out. Before the room's check-out
 *                   date it is an early departure: the date is shortened and
 *                   unused extension nights are voided (no refund of prepaid
 *                   nights).
 *   settleCheckout  at the check-out that leaves no room checked in, settle all
 *                   Unpaid charges in ONE Checkout payment (sum > 0), or record
 *                   a Checkout Credit refund (sum < 0).
 *
 * The reservation becomes Completed as soon as no room is checked in or still
 * expected and nothing is Unpaid; the database then credits the earned points.
 */
import type { Db, Row } from "./db/types";
import { AppError } from "./errors";
import { setActor, setHotelDay, type Actor } from "./audit";
import { mapDbError } from "./crud";
import { ENUMS } from "./entities";
import {
  assertFrontDesk,
  assertRoomAvailable,
  lockLoyaltyFor,
  lockReservation,
  roomPriceCents,
  tryComplete,
  unpaidCharges,
} from "./rules";
import { addDays, hotelNow, hotelToday, nightsBetween } from "./dates";
import { peso, pointsEarned, toCents } from "./money";
import { isMoney, isRealDate } from "./validation";
import { sendFor, type EmailOutcome } from "./email";

type RoomRow = {
  res_room_id: number;
  res_id: number;
  room_no: number;
  check_in_date: string;
  check_out_date: string;
  actual_check_in: string | null;
  actual_check_out: string | null;
};

async function lockRoomRow(t: Db, resRoomId: unknown): Promise<RoomRow> {
  const r = await t.query<RoomRow>(
    `SELECT res_room_id, res_id, room_no, check_in_date::text, check_out_date::text,
            actual_check_in::text, actual_check_out::text
       FROM bookinn.reservation_room WHERE res_room_id = $1 FOR UPDATE`,
    [resRoomId],
  );
  if (!r.rows[0]) throw new AppError("validation", `Reserved room #${resRoomId} does not exist.`);
  return r.rows[0];
}

async function inTx<T>(db: Db, actor: Actor, now: Date, fn: (t: Db, today: string, nowLocal: string) => Promise<T>): Promise<T> {
  const today = hotelToday(now);
  try {
    return await db.tx(async (t) => {
      await setActor(t, actor);
      await setHotelDay(t, today);
      return fn(t, today, hotelNow(now));
    });
  } catch (err) {
    mapDbError(err);
  }
}

async function hasSettlement(t: Db, resId: unknown) {
  const r = await t.query(
    `SELECT 1 FROM bookinn.payment WHERE res_id = $1 AND pay_type = 'Checkout'
     UNION ALL SELECT 1 FROM bookinn.refund WHERE res_id = $1 AND refund_type = 'Checkout Credit'`,
    [resId],
  );
  return r.rows.length > 0;
}

async function roomsCheckedIn(t: Db, resId: unknown) {
  const r = await t.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM bookinn.reservation_room WHERE res_id = $1 AND actual_check_in IS NOT NULL AND actual_check_out IS NULL",
    [resId],
  );
  return Number(r.rows[0].n);
}

// ---------------------------------------------------------------- check-in
export async function checkInRoom(db: Db, actor: Actor, resRoomId: string | number, now: Date = new Date()) {
  assertFrontDesk(actor, "check guests in");
  return inTx(db, actor, now, async (t, today, nowLocal) => {
    const room = await lockRoomRow(t, resRoomId);
    const res = await lockReservation(t, room.res_id);
    if (res.booking_status !== "Booked" && res.booking_status !== "Checked-In")
      throw new AppError("conflict", `Reservation #${res.res_id} is ${res.booking_status}; rooms can no longer be checked in.`);
    if (room.actual_check_in) throw new AppError("conflict", `Room ${room.room_no} was already checked in at ${room.actual_check_in}.`);
    if (today < room.check_in_date)
      throw new AppError("validation", `Room ${room.room_no} cannot be checked in before its check-in date (${room.check_in_date}).`);
    if (today >= room.check_out_date)
      throw new AppError("validation", `Room ${room.room_no}'s stay ended on ${room.check_out_date}; it can no longer be checked in.`);
    await t.query("UPDATE bookinn.reservation_room SET actual_check_in = $2 WHERE res_room_id = $1", [room.res_room_id, nowLocal]);
    if (res.booking_status === "Booked")
      await t.query("UPDATE bookinn.reservation SET booking_status = 'Checked-In' WHERE res_id = $1", [res.res_id]);
    return { resId: Number(res.res_id), resRoomId: Number(room.res_room_id), checkedInAt: nowLocal };
  });
}

// ---------------------------------------------------------------- extension
export interface ExtensionResult {
  resId: number;
  resRoomId: number;
  inPlace: boolean;
  chargeId: number;
  extFrom: string;
  extTo: string;
  amountCents: number;
}

/**
 * Extends a checked-in room to `newCheckOut`. Without `roomNo` (or with the
 * same room) the room's check-out is extended in place if its following
 * nights are free. With another `roomNo`, a new reserved-room row is added
 * from the current check-out date (it is checked in like any other room).
 */
export async function extendStay(
  db: Db,
  actor: Actor,
  resRoomId: string | number,
  newCheckOut: string,
  opts: { roomNo?: string | number } = {},
  now: Date = new Date(),
): Promise<ExtensionResult> {
  assertFrontDesk(actor, "extend stays");
  if (!isRealDate(newCheckOut)) throw new AppError("validation", "Enter a valid new check-out date.", { check_out_date: "Invalid date." });
  return inTx(db, actor, now, async (t, today) => {
    const room = await lockRoomRow(t, resRoomId);
    const res = await lockReservation(t, room.res_id);
    if (res.booking_status !== "Checked-In")
      throw new AppError("conflict", `Only Checked-In reservations can be extended; #${res.res_id} is ${res.booking_status}. Before check-in, edit the reservation instead.`);
    if (!room.actual_check_in || room.actual_check_out)
      throw new AppError("conflict", `Room ${room.room_no} is not checked in, so its stay cannot be extended.`);
    if (await hasSettlement(t, res.res_id))
      throw new AppError("conflict", `Reservation #${res.res_id} has already been settled at check-out; no new charges can be added.`);
    const extFrom: string = room.check_out_date;
    if (newCheckOut <= extFrom)
      throw new AppError("validation", `The new check-out must be after ${extFrom}.`, { check_out_date: `After ${extFrom}.` });

    const target = opts.roomNo == null || String(opts.roomNo) === String(room.room_no) ? null : String(opts.roomNo);
    let rowId = Number(room.res_room_id);
    if (target === null) {
      await assertRoomAvailable(t, room.room_no, extFrom, newCheckOut, { excludeResRoomId: room.res_room_id });
      await t.query("UPDATE bookinn.reservation_room SET check_out_date = $2 WHERE res_room_id = $1", [room.res_room_id, newCheckOut]);
    } else {
      if (extFrom < today)
        throw new AppError("validation", `An extension in another room cannot start in the past; extend room ${room.room_no} in place instead.`);
      await assertRoomAvailable(t, target, extFrom, newCheckOut, { resId: res.res_id });
      const r = await t.query<{ res_room_id: number }>(
        "INSERT INTO bookinn.reservation_room (res_id, room_no, check_in_date, check_out_date) VALUES ($1, $2, $3, $4) RETURNING res_room_id",
        [res.res_id, target, extFrom, newCheckOut],
      );
      rowId = r.rows[0].res_room_id;
    }
    const amount = nightsBetween(extFrom, newCheckOut) * (await roomPriceCents(t, target ?? room.room_no));
    const c = await t.query<{ charge_id: number }>(
      `INSERT INTO bookinn.adjustment_charge (res_id, res_room_id, charge_type, ext_from, ext_to, charge_amt)
       VALUES ($1, $2, 'Extension', $3, $4, $5) RETURNING charge_id`,
      [res.res_id, rowId, extFrom, newCheckOut, amount / 100],
    );
    return { resId: Number(res.res_id), resRoomId: rowId, inPlace: target === null, chargeId: c.rows[0].charge_id, extFrom, extTo: newCheckOut, amountCents: amount };
  });
}

// ---------------------------------------------------------------- check-out
export interface CheckOutResult {
  resId: number;
  resRoomId: number;
  checkedOutAt: string;
  earlyDeparture: boolean;
  checkOutDate: string;
  voidedChargeIds: number[];
  /** Replacement Extension charge for the extension nights actually used. */
  repostedChargeId: number | null;
  /** True when no room of the reservation is still checked in: settle with settleCheckout. */
  lastRoom: boolean;
  dueCents: number;
  unpaidCount: number;
  completed: boolean;
}

export async function checkOutRoom(db: Db, actor: Actor, resRoomId: string | number, now: Date = new Date()): Promise<CheckOutResult> {
  assertFrontDesk(actor, "check guests out");
  return inTx(db, actor, now, async (t, today, nowLocal) => {
    const room = await lockRoomRow(t, resRoomId);
    const res = await lockReservation(t, room.res_id);
    if (res.booking_status !== "Checked-In") throw new AppError("conflict", `Reservation #${res.res_id} is ${res.booking_status}, not Checked-In.`);
    if (!room.actual_check_in) throw new AppError("conflict", `Room ${room.room_no} was never checked in.`);
    if (room.actual_check_out) throw new AppError("conflict", `Room ${room.room_no} was already checked out at ${room.actual_check_out}.`);

    // Early departure: the check-out date becomes the departure date (at least one night).
    let checkOutDate: string = room.check_out_date;
    const voided: number[] = [];
    let reposted: number | null = null;
    const early = today < room.check_out_date;
    if (early) {
      checkOutDate = today > room.check_in_date ? today : addDays(room.check_in_date, 1);
      if (checkOutDate < room.check_out_date) {
        const ext = await t.query<{ charge_id: number; ext_from: string; ext_to: string }>(
          `SELECT charge_id, ext_from::text, ext_to::text FROM bookinn.adjustment_charge
            WHERE res_room_id = $1 AND charge_type = 'Extension' AND pay_status = 'Unpaid' AND ext_to > $2::date FOR UPDATE`,
          [room.res_room_id, checkOutDate],
        );
        const price = await roomPriceCents(t, room.room_no);
        for (const c of ext.rows) {
          await t.query("UPDATE bookinn.adjustment_charge SET pay_status = 'Voided' WHERE charge_id = $1", [c.charge_id]);
          voided.push(c.charge_id);
          if (c.ext_from < checkOutDate) {
            // Part of the extension was used: post the used nights again at the room rate.
            const r = await t.query<{ charge_id: number }>(
              `INSERT INTO bookinn.adjustment_charge (res_id, res_room_id, charge_type, ext_from, ext_to, charge_amt)
               VALUES ($1, $2, 'Extension', $3, $4, $5) RETURNING charge_id`,
              [res.res_id, room.res_room_id, c.ext_from, checkOutDate, (nightsBetween(c.ext_from, checkOutDate) * price) / 100],
            );
            reposted = r.rows[0].charge_id;
          }
        }
        await t.query("UPDATE bookinn.reservation_room SET check_out_date = $2 WHERE res_room_id = $1", [room.res_room_id, checkOutDate]);
      }
    }
    await t.query("UPDATE bookinn.reservation_room SET actual_check_out = $2 WHERE res_room_id = $1", [room.res_room_id, nowLocal]);

    const lastRoom = (await roomsCheckedIn(t, res.res_id)) === 0;
    const unpaid = await unpaidCharges(t, res.res_id);
    const completed = lastRoom && unpaid.ids.length === 0 ? await tryComplete(t, res.res_id, today) : false;
    return {
      resId: Number(res.res_id),
      resRoomId: Number(room.res_room_id),
      checkedOutAt: nowLocal,
      earlyDeparture: early,
      checkOutDate,
      voidedChargeIds: voided,
      repostedChargeId: reposted,
      lastRoom,
      dueCents: unpaid.totalCents,
      unpaidCount: unpaid.ids.length,
      completed,
    };
  });
}

// ---------------------------------------------------------------- settlement
export interface SettlementInput {
  pay_method?: string;
  pay_amt?: string;
}
export interface SettlementResult {
  resId: number;
  amountCents: number;
  settledChargeIds: number[];
  payId: number | null;
  rctNo: number | null;
  refundId: number | null;
  pointsEarned: number;
  completed: boolean;
  emails?: EmailOutcome[];
}

/** Amount due at check-out: Σ Unpaid charges, including negative ones. */
export async function checkoutDue(db: Db, resId: string | number) {
  const t = db;
  const r = await t.query<{ s: string; n: number }>(
    "SELECT COALESCE(sum(charge_amt), 0)::text AS s, count(*)::int AS n FROM bookinn.adjustment_charge WHERE res_id = $1 AND pay_status = 'Unpaid'",
    [resId],
  );
  return { dueCents: toCents(r.rows[0].s), unpaidCount: Number(r.rows[0].n) };
}

export async function settleCheckout(
  db: Db,
  actor: Actor,
  resId: string | number,
  input: SettlementInput = {},
  now: Date = new Date(),
): Promise<SettlementResult> {
  assertFrontDesk(actor, "record check-out payments");
  const r = await inTx(db, actor, now, async (t, today) => {
    const res: Row = await lockReservation(t, resId);
    if (res.booking_status !== "Checked-In")
      throw new AppError("conflict", `Reservation #${res.res_id} is ${res.booking_status}; the check-out bill is settled while it is Checked-In.`);
    if ((await roomsCheckedIn(t, res.res_id)) > 0)
      throw new AppError("conflict", "The bill is settled at the check-out that leaves no room checked in. Check out the remaining rooms first.");
    if (await hasSettlement(t, res.res_id)) throw new AppError("conflict", `Reservation #${res.res_id} already has its Checkout settlement.`);
    const unpaid = await unpaidCharges(t, res.res_id);
    if (!unpaid.ids.length) throw new AppError("conflict", `Reservation #${res.res_id} has no Unpaid charges to settle.`);
    const sum = unpaid.totalCents;

    let payId: number | null = null;
    let rctNo: number | null = null;
    let refundId: number | null = null;
    let earned = 0;
    if (sum > 0) {
      const method = String(input.pay_method ?? "");
      if (!(ENUMS.pay_method as readonly string[]).includes(method))
        throw new AppError("validation", "Choose the payment method.", { pay_method: "Required." });
      const amt = String(input.pay_amt ?? "").trim();
      if (!isMoney(amt) || toCents(amt) !== sum)
        throw new AppError("validation", `The Checkout payment must be exactly ${peso(sum)} (the sum of the Unpaid charges).`, {
          pay_amt: `Amount due is ${peso(sum)}.`,
        });
      const account = await lockLoyaltyFor(t, res.res_id);
      earned = account ? pointsEarned(sum) : 0;
      const p = await t.query<{ pay_id: number }>(
        `INSERT INTO bookinn.payment (res_id, pay_type, pay_method, pay_date, pay_amt, pts_earn, pts_spend, discount_type)
         VALUES ($1, 'Checkout', $2, $3, $4, $5, 0, 'NONE') RETURNING pay_id`,
        [res.res_id, method, today, sum / 100, earned],
      );
      payId = p.rows[0].pay_id;
      rctNo = (await t.query<{ rct_no: number }>("INSERT INTO bookinn.receipt (pay_id) VALUES ($1) RETURNING rct_no", [payId])).rows[0].rct_no;
    } else if (sum < 0) {
      const r = await t.query<{ refund_id: number }>(
        "INSERT INTO bookinn.refund (res_id, refund_type, refund_amt, refund_date) VALUES ($1, 'Checkout Credit', $2, $3) RETURNING refund_id",
        [res.res_id, -sum / 100, today],
      );
      refundId = r.rows[0].refund_id;
    }
    await t.query("UPDATE bookinn.adjustment_charge SET pay_status = 'Paid', pay_id = $2 WHERE charge_id = ANY($1::int[])", [unpaid.ids, payId]);
    const completed = await tryComplete(t, res.res_id, today);
    return { resId: Number(res.res_id), amountCents: sum, settledChargeIds: unpaid.ids, payId, rctNo, refundId, pointsEarned: earned, completed };
  });
  // After commit: receipt for the Checkout payment, or confirmation of the Checkout Credit refund.
  const emails = await sendFor(db, { payIds: [r.payId], refundIds: [r.refundId] });
  return { ...r, emails };
}
