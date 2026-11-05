/**
 * SRS v2 §3.3 business rules shared by the Front Desk flows (booking.ts,
 * modify.ts, stay.ts) and the generic record screens. Each hook runs inside
 * the same transaction as the write it guards, so a rejected rule leaves no
 * trace. The reservation/payment hooks cover Database Administrator
 * corrections (§1.4: errors in Completed, Cancelled or No-Show records are
 * corrected only by the Database Administrator). Every change is recorded by
 * the audit triggers; the database (migration 0005) enforces the same rules.
 */
import bcrypt from "bcryptjs";
import type { Db, Row } from "./db/types";
import { DBA, FD, type EntityDef } from "./entities";
import { AppError } from "./errors";
import type { Actor } from "./audit";
import { amountDue, peso, pointsEarned, pointsFor, toCents, type Discount } from "./money";
import { beforeCutoff, cutoffFor, hotelNow, hotelToday } from "./dates";

type Values = Record<string, unknown>;
export const BCRYPT_COST = Number(process.env.BCRYPT_COST ?? 12);

// ---------------------------------------------------------------- permissions
/**
 * Front Desk actions on reservations (Table 2: create, read, update, cancel,
 * check in, check out; charges and refunds). The Database Administrator has
 * "All" and may perform them too.
 */
export function assertFrontDesk(actor: Actor, what: string) {
  if (actor.role !== FD && actor.role !== DBA)
    throw new AppError("forbidden", `Your role (${actor.role}) cannot ${what}.`);
}

// ---------------------------------------------------------------- shared lookups
export async function lockReservation(t: Db, resId: unknown): Promise<Row> {
  const r = await t.query("SELECT * FROM bookinn.reservation WHERE res_id = $1 FOR UPDATE", [resId]);
  if (!r.rows[0]) throw new AppError("validation", `Reservation #${resId} does not exist.`, { res_id: "Not found." });
  return r.rows[0];
}

/** Earliest check-in of a reservation, which applies to the whole reservation for the 48-hour cutoff. */
export async function earliestCheckIn(t: Db, resId: unknown): Promise<string | null> {
  const r = await t.query<{ d: string | null }>("SELECT min(check_in_date)::text AS d FROM bookinn.reservation_room WHERE res_id = $1", [resId]);
  return r.rows[0]?.d ?? null;
}

/**
 * Friendly double-booking check: runs the same function the database trigger
 * uses (bookinn.assert_room_free), so Booked and Checked-In reservations count,
 * a checked-in room stays blocked until it is checked out, and stays are
 * half-open [check-in, check-out). `resId` leaves that reservation's own rooms
 * out (an edit); `excludeResRoomId` leaves one row out.
 */
export async function assertRoomAvailable(
  t: Db,
  roomNo: unknown,
  checkIn: unknown,
  checkOut: unknown,
  opts: { excludeResRoomId?: unknown; resId?: unknown } = {},
) {
  const room = await t.query("SELECT room_no FROM bookinn.room WHERE room_no = $1", [roomNo]);
  if (!room.rows[0]) throw new AppError("validation", `Room ${roomNo} does not exist.`, { room_no: "Not found." });
  try {
    await t.query("SELECT bookinn.assert_room_free($1::int, $2::date, $3::date, $4::int, $5::int)", [
      roomNo,
      checkIn,
      checkOut,
      opts.resId ?? -1,
      opts.excludeResRoomId ?? null,
    ]);
  } catch (err) {
    const pg = err as { code?: string; message?: string };
    if (pg.code === "23P01") throw new AppError("conflict", pg.message ?? "Room is not available.", { room_no: "Not available for these dates." });
    throw err;
  }
}

async function assertReservationRoomsAvailable(t: Db, resId: unknown) {
  const rooms = await t.query(
    "SELECT res_room_id, room_no, check_in_date, check_out_date FROM bookinn.reservation_room WHERE res_id = $1 AND actual_check_out IS NULL",
    [resId],
  );
  for (const r of rooms.rows)
    await assertRoomAvailable(t, r.room_no, r.check_in_date, r.check_out_date, { excludeResRoomId: r.res_room_id, resId });
}

/** Nightly price of a room, from ROOM_DETAILS (no price is stored on the reservation). */
export async function roomPriceCents(t: Db, roomNo: unknown): Promise<number> {
  const r = await t.query<{ p: string }>(
    "SELECT d.room_price::text AS p FROM bookinn.room ro JOIN bookinn.room_details d ON d.room_type_id = ro.room_type_id WHERE ro.room_no = $1",
    [roomNo],
  );
  if (!r.rows[0]) throw new AppError("validation", `Room ${roomNo} does not exist.`, { room_no: "Not found." });
  return toCents(r.rows[0].p);
}

/** Base cost of a reservation = Σ nightly price × nights, with the highest nightly price (for Free Night). */
export async function reservationCost(t: Db, resId: unknown) {
  const r = await t.query<{ total: string; max_price: string; n: string }>(
    `SELECT COALESCE(SUM(d.room_price * (rr.check_out_date - rr.check_in_date)), 0)::text AS total,
            COALESCE(MAX(d.room_price), 0)::text AS max_price,
            COUNT(*)::text AS n
       FROM bookinn.reservation_room rr
       JOIN bookinn.room ro        ON ro.room_no = rr.room_no
       JOIN bookinn.room_details d ON d.room_type_id = ro.room_type_id
      WHERE rr.res_id = $1`,
    [resId],
  );
  const { total, max_price, n } = r.rows[0];
  return { totalCents: toCents(total), maxPriceCents: toCents(max_price), rooms: Number(n) };
}

/** Locks the guest's loyalty account (if any) for a reservation. */
export async function lockLoyaltyFor(t: Db, resId: unknown) {
  const r = await t.query<{ lyl_id: number; total_pts: number }>(
    `SELECT l.lyl_id, l.total_pts FROM bookinn.loyalty_acc l
       JOIN bookinn.reservation r ON r.cus_id = l.cus_id
      WHERE r.res_id = $1 FOR UPDATE OF l`,
    [resId],
  );
  return r.rows[0];
}

/** Applies a point change atomically; the CHECK (total_pts >= 0) rejects overspending. */
export async function adjustPoints(t: Db, lylId: number, delta: number) {
  if (delta === 0) return;
  await t.query("UPDATE bookinn.loyalty_acc SET total_pts = total_pts + $2 WHERE lyl_id = $1", [lylId, delta]);
}

/** Σ of a reservation's Unpaid charges, including negative ones (§3.3 Amount Due at Check-out). */
export async function unpaidCharges(t: Db, resId: unknown) {
  const r = await t.query<{ charge_id: number; charge_amt: string }>(
    "SELECT charge_id, charge_amt::text FROM bookinn.adjustment_charge WHERE res_id = $1 AND pay_status = 'Unpaid' ORDER BY charge_id FOR UPDATE",
    [resId],
  );
  return { ids: r.rows.map((c) => c.charge_id), totalCents: r.rows.reduce((a, c) => a + toCents(c.charge_amt), 0) };
}

/**
 * Sets a Checked-In reservation to Completed when no room is still checked in,
 * none is still expected (a room never checked in is ignored once its
 * check-out date has passed) and no charge is Unpaid. The database credits
 * the earned points at that moment. Returns true when it completed.
 */
export async function tryComplete(t: Db, resId: unknown, today: string): Promise<boolean> {
  const r = await t.query(
    `UPDATE bookinn.reservation r SET booking_status = 'Completed'
      WHERE r.res_id = $1 AND r.booking_status = 'Checked-In'
        AND NOT EXISTS (SELECT 1 FROM bookinn.reservation_room rr WHERE rr.res_id = r.res_id
                         AND ((rr.actual_check_in IS NOT NULL AND rr.actual_check_out IS NULL)
                              OR (rr.actual_check_in IS NULL AND rr.check_out_date >= $2::date)))
        AND NOT EXISTS (SELECT 1 FROM bookinn.adjustment_charge a WHERE a.res_id = r.res_id AND a.pay_status = 'Unpaid')
      RETURNING res_id`,
    [resId, today],
  );
  return r.rows.length > 0;
}

// ---------------------------------------------------------------- cancellation
export interface CancellationOutcome {
  resId: number;
  onTime: boolean;
  cutoff: string | null;
  refundId: number | null;
  refundCents: number;
  pointsReturned: number;
  voidedChargeIds: number[];
}

/**
 * Everything that follows a guest cancellation (FR-27, §3.3 Cancellations):
 * Unpaid charges are voided; at least 48 hours before the earliest check-in
 * (14:00) the amount paid is refunded in full, otherwise nothing; the points
 * spent on the reservation are returned and earned points are never credited.
 * The CANCELLATION row must already exist. A ₱0 paid amount still records a
 * ₱0 Cancellation refund when on time (SRS_AUDIT B9).
 */
export async function finishCancellation(t: Db, res: Row, nowLocal: string, today: string): Promise<CancellationOutcome> {
  if (res.booking_status !== "Booked")
    throw new AppError("conflict", `Only Booked reservations can be cancelled; #${res.res_id} is ${res.booking_status}.`);
  const earliest = await earliestCheckIn(t, res.res_id);
  const onTime = earliest ? beforeCutoff(nowLocal, earliest) : true;

  const voided = await t.query<{ charge_id: number }>(
    "UPDATE bookinn.adjustment_charge SET pay_status = 'Voided' WHERE res_id = $1 AND pay_status = 'Unpaid' RETURNING charge_id",
    [res.res_id],
  );
  const paid = await t.query<{ amt: string; spent: string }>(
    "SELECT COALESCE(sum(pay_amt), 0)::text AS amt, COALESCE(sum(pts_spend), 0)::text AS spent FROM bookinn.payment WHERE res_id = $1",
    [res.res_id],
  );
  const paidCents = toCents(paid.rows[0].amt);
  const spent = Number(paid.rows[0].spent);

  let refundId: number | null = null;
  if (onTime) {
    const r = await t.query<{ refund_id: number }>(
      "INSERT INTO bookinn.refund (res_id, refund_type, refund_amt, refund_date) VALUES ($1, 'Cancellation', $2, $3) RETURNING refund_id",
      [res.res_id, paidCents / 100, today],
    );
    refundId = r.rows[0].refund_id;
  }
  const account = await lockLoyaltyFor(t, res.res_id);
  if (account && spent > 0) await adjustPoints(t, account.lyl_id, spent);
  await t.query("UPDATE bookinn.reservation SET booking_status = 'Cancelled' WHERE res_id = $1", [res.res_id]);
  return {
    resId: Number(res.res_id),
    onTime,
    cutoff: earliest ? cutoffFor(earliest) : null,
    refundId,
    refundCents: onTime ? paidCents : 0,
    pointsReturned: account ? spent : 0,
    voidedChargeIds: voided.rows.map((v) => v.charge_id),
  };
}

// ---------------------------------------------------------------- payments (administrator corrections)
/**
 * Validates a payment against the server-computed amount due and derives
 * PTS_EARN / PTS_SPEND. Initial: the discounted total. Checkout: the sum of
 * the Unpaid charges (or, when correcting, of the charges it settled), with
 * no discount. Spent points are deducted at payment; earned points only count
 * on the account once the reservation is Completed.
 * `previous` is the stored payment when correcting one.
 */
async function preparePayment(t: Db, res: Row, v: Values, previous?: Row): Promise<Values> {
  const type = String(previous?.pay_type ?? v.pay_type ?? "Initial");
  const discount = String(v.discount_type ?? "NONE") as Discount;
  const account = await lockLoyaltyFor(t, res.res_id);
  const amt = toCents(v.pay_amt);
  let due: number;

  if (type === "Checkout") {
    if (discount !== "NONE")
      throw new AppError("validation", "Checkout payments use no discount (NONE).", { discount_type: "Must be NONE." });
    const r = await t.query<{ s: string }>(
      previous
        ? "SELECT COALESCE(sum(charge_amt), 0)::text AS s FROM bookinn.adjustment_charge WHERE pay_id = $1"
        : "SELECT COALESCE(sum(charge_amt), 0)::text AS s FROM bookinn.adjustment_charge WHERE res_id = $1 AND pay_status = 'Unpaid'",
      [previous ? previous.pay_id : res.res_id],
    );
    due = toCents(r.rows[0].s);
  } else {
    const cost = await reservationCost(t, res.res_id);
    if (cost.rooms === 0)
      throw new AppError("validation", `Reservation #${res.res_id} has no rooms; add a reserved room before recording payment.`);
    due = amountDue(cost.totalCents, cost.maxPriceCents, discount);
  }
  if (amt !== due)
    throw new AppError("validation", `The payment must equal the amount due of ${peso(due)} (no partial or over-payment).`, {
      pay_amt: `Amount due is ${peso(due)}.`,
    });

  const { earn, spend } = type === "Checkout" ? { earn: account ? pointsEarned(amt) : 0, spend: 0 } : pointsFor(amt, discount, !!account);
  if (spend > 0 && !account)
    throw new AppError("validation", "Loyalty discounts require the guest to have a loyalty account.", { discount_type: "No loyalty account." });
  const completed = res.booking_status === "Completed";
  const delta =
    -(spend - Number(previous?.pts_spend ?? 0)) + (completed ? earn - Number(previous?.pts_earn ?? 0) : 0);
  if (account) {
    if (account.total_pts + delta < 0)
      throw new AppError("validation", `${discount} needs ${spend} points; the account has ${account.total_pts}.`, {
        discount_type: "Not enough points.",
      });
    await adjustPoints(t, account.lyl_id, delta);
  }
  return { ...v, pay_type: type, pts_spend: spend, pts_earn: earn };
}

async function activeAdminsExcept(t: Db, staffId: unknown) {
  const r = await t.query(
    "SELECT count(*)::int AS n FROM bookinn.staff WHERE role = 'Database Administrator' AND is_active = 'Yes' AND staff_id <> $1",
    [staffId],
  );
  return Number(r.rows[0].n);
}

function assertDates(v: Values) {
  if (String(v.check_out_date) <= String(v.check_in_date))
    throw new AppError("validation", "Check-out date must be after check-in date.", {
      check_out_date: "Must be after check-in.",
    });
}

/** Hotel time on `today` at the current wall-clock time (generic forms pass a date only). */
const nowOn = (today: string) => (today === hotelToday() ? hotelNow() : `${today} ${hotelNow().slice(11)}`);

// ---------------------------------------------------------------- hooks
export async function beforeCreate(t: Db, e: EntityDef, v: Values, _actor: Actor, today = hotelToday()): Promise<Values> {
  switch (e.key) {
    case "reservation_room": {
      await lockReservation(t, v.res_id);
      assertDates(v);
      await assertRoomAvailable(t, v.room_no, v.check_in_date, v.check_out_date, { resId: v.res_id });
      return v;
    }
    case "payment": {
      const res = await lockReservation(t, v.res_id);
      if (res.booking_status === "Cancelled" || res.booking_status === "No-Show")
        throw new AppError("conflict", `Reservation #${res.res_id} is ${res.booking_status}; no payment can be recorded.`);
      return preparePayment(t, res, v);
    }
    case "cancellation": {
      const res = await lockReservation(t, v.res_id);
      if (res.booking_status !== "Booked")
        throw new AppError("conflict", `Only Booked reservations can be cancelled; #${res.res_id} is ${res.booking_status}.`);
      if (String(v.cancel_date) > today)
        throw new AppError("validation", "The cancellation date cannot be in the future.", { cancel_date: `On or before ${today}.` });
      return v;
    }
    case "loyalty_acc":
      return { ...v, total_pts: v.total_pts ?? 0 };
    case "staff":
      return { ...v, pass: await bcrypt.hash(String(v.pass), BCRYPT_COST) };
    default:
      return v;
  }
}

export async function afterCreate(t: Db, e: EntityDef, row: Row, today = hotelToday()) {
  if (e.key === "payment") {
    // SRS: a traceable receipt is issued for every payment.
    await t.query("INSERT INTO bookinn.receipt (pay_id) VALUES ($1)", [row.pay_id]);
  }
  if (e.key === "cancellation") {
    const res = await lockReservation(t, row.res_id);
    await finishCancellation(t, res, nowOn(today), today);
  }
}

export async function beforeUpdate(t: Db, e: EntityDef, old: Row, v: Values, actor: Actor): Promise<Values> {
  switch (e.key) {
    case "reservation": {
      const res = await lockReservation(t, old.res_id);
      if (res.booking_status === "Cancelled" && v.booking_status !== "Cancelled")
        throw new AppError("conflict", "Cancelled reservations are reinstated by deleting the cancellation record.");
      if (!["Booked", "Checked-In"].includes(String(old.booking_status)) && ["Booked", "Checked-In"].includes(String(v.booking_status)))
        await assertReservationRoomsAvailable(t, old.res_id);
      return v;
    }
    case "reservation_room": {
      await lockReservation(t, old.res_id);
      assertDates(v);
      await assertRoomAvailable(t, v.room_no, v.check_in_date, v.check_out_date, {
        excludeResRoomId: old.res_room_id,
        resId: old.res_id,
      });
      return v;
    }
    case "payment": {
      const res = await lockReservation(t, old.res_id);
      return preparePayment(t, res, v, old);
    }
    case "staff": {
      const next = { ...v };
      if (next.pass !== undefined) next.pass = await bcrypt.hash(String(next.pass), BCRYPT_COST);
      const losesAdmin =
        old.role === "Database Administrator" &&
        ((next.role ?? old.role) !== "Database Administrator" || (next.is_active ?? old.is_active) === "No");
      if (losesAdmin && Number(old.staff_id) === actor.staffId)
        throw new AppError("conflict", "You cannot deactivate or demote your own administrator account.");
      if (losesAdmin && old.is_active === "Yes" && (await activeAdminsExcept(t, old.staff_id)) === 0)
        throw new AppError("conflict", "At least one active Database Administrator must remain.");
      return next;
    }
    default:
      return v;
  }
}

export async function beforeDelete(t: Db, e: EntityDef, old: Row, actor: Actor) {
  switch (e.key) {
    case "payment": {
      // Removing a wrongly entered payment (administrator correction) undoes its points:
      // spent points come back; earned points are taken back if they were credited.
      const res = await lockReservation(t, old.res_id);
      const account = await lockLoyaltyFor(t, old.res_id);
      const delta = Number(old.pts_spend) - (res.booking_status === "Completed" ? Number(old.pts_earn) : 0);
      if (account) {
        if (account.total_pts + delta < 0)
          throw new AppError(
            "conflict",
            `Deleting this payment would take back ${old.pts_earn} points, but the account only has ${account.total_pts}.`,
          );
        await adjustPoints(t, account.lyl_id, delta);
      }
      return;
    }
    case "cancellation": {
      const refund = await t.query("SELECT 1 FROM bookinn.refund WHERE res_id = $1 AND refund_type = 'Cancellation'", [old.res_id]);
      if (refund.rows.length)
        throw new AppError("conflict", "This cancellation has a refund. Delete the Cancellation refund first, then reinstate the booking.");
      return;
    }
    case "staff":
      if (Number(old.staff_id) === actor.staffId) throw new AppError("conflict", "You cannot delete your own account.");
      if (old.role === "Database Administrator" && old.is_active === "Yes" && (await activeAdminsExcept(t, old.staff_id)) === 0)
        throw new AppError("conflict", "At least one active Database Administrator must remain.");
      return;
  }
}

export async function afterDelete(t: Db, e: EntityDef, old: Row) {
  if (e.key === "cancellation") {
    // Undoing a cancellation reinstates the booking only if its rooms are still free,
    // and takes the returned spent points again.
    const res = await lockReservation(t, old.res_id);
    if (res.booking_status === "Cancelled") {
      await assertReservationRoomsAvailable(t, old.res_id);
      const spent = await t.query<{ s: string }>("SELECT COALESCE(sum(pts_spend), 0)::text AS s FROM bookinn.payment WHERE res_id = $1", [old.res_id]);
      const account = await lockLoyaltyFor(t, old.res_id);
      if (account && Number(spent.rows[0].s) > 0) {
        if (account.total_pts < Number(spent.rows[0].s))
          throw new AppError("conflict", `Reinstating needs ${spent.rows[0].s} points again; the account has ${account.total_pts}.`);
        await adjustPoints(t, account.lyl_id, -Number(spent.rows[0].s));
      }
      await t.query("UPDATE bookinn.reservation SET booking_status = 'Booked' WHERE res_id = $1", [old.res_id]);
    }
  }
}
