/**
 * SRS §3.3 business rules that apply to basic CRUD. Each hook runs inside the
 * same transaction as the write it guards, so a rejected rule leaves no trace.
 */
import bcrypt from "bcryptjs";
import type { Db, Row } from "./db/types";
import { ENTITIES, type EntityDef } from "./entities";
import { AppError } from "./errors";
import { describe, writeAudit, type Actor } from "./audit";

type Values = Record<string, unknown>;
export const BCRYPT_COST = Number(process.env.BCRYPT_COST ?? 12);

// ---------------------------------------------------------------- money
export function toCents(v: unknown): number {
  const [whole, frac = ""] = String(v).split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}
export const fromCents = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
const peso = (c: number) => `₱${fromCents(c)}`;

/** Points earned = floor(total payment / 50) (SRS §3.3 Loyalty). */
export const pointsEarned = (amtCents: number) => Math.floor(amtCents / 5000);
export const DISCOUNT_POINTS: Record<string, number> = { NONE: 0, "12% Discount": 100, "Free Night": 250 };

// ---------------------------------------------------------------- shared lookups
async function lockReservation(t: Db, resId: unknown): Promise<Row> {
  const r = await t.query("SELECT * FROM bookinn.reservation WHERE res_id = $1 FOR UPDATE", [resId]);
  if (!r.rows[0]) throw new AppError("validation", `Reservation #${resId} does not exist.`, { res_id: "Not found." });
  return r.rows[0];
}

async function hasPayment(t: Db, resId: unknown) {
  const r = await t.query("SELECT 1 FROM bookinn.payment WHERE res_id = $1", [resId]);
  return r.rows.length > 0;
}

function assertEditableBooking(res: Row, paid: boolean) {
  if (res.booking_status !== "Booked")
    throw new AppError("conflict", `Reservation #${res.res_id} is ${res.booking_status}; its rooms can no longer be changed.`);
  if (paid)
    throw new AppError(
      "conflict",
      `Reservation #${res.res_id} has already been paid, so its details are locked (FR-14). Create a new reservation instead.`,
    );
}

/**
 * FR-15/FR-16 double-booking guard. Only reservations still "Booked" count;
 * Cancelled and Completed ones free the room (SRS §3.3 Room Availability).
 * The ROOM row lock serialises concurrent bookings of the same room.
 */
export async function assertRoomAvailable(
  t: Db,
  roomNo: unknown,
  checkIn: unknown,
  checkOut: unknown,
  excludeResRoomId: unknown = null,
) {
  const room = await t.query("SELECT room_no FROM bookinn.room WHERE room_no = $1 FOR UPDATE", [roomNo]);
  if (!room.rows[0]) throw new AppError("validation", `Room ${roomNo} does not exist.`, { room_no: "Not found." });
  const clash = await t.query(
    `SELECT rr.res_id, rr.check_in_date, rr.check_out_date
       FROM bookinn.reservation_room rr
       JOIN bookinn.reservation r ON r.res_id = rr.res_id
      WHERE rr.room_no = $1
        AND r.booking_status = 'Booked'
        AND rr.check_in_date  < $3::date
        AND rr.check_out_date > $2::date
        AND rr.res_room_id <> COALESCE($4::int, -1)
      LIMIT 1`,
    [roomNo, checkIn, checkOut, excludeResRoomId],
  );
  const c = clash.rows[0];
  if (c)
    throw new AppError(
      "conflict",
      `Room ${roomNo} is already booked from ${c.check_in_date} to ${c.check_out_date} (reservation #${c.res_id}).`,
      { room_no: "Not available for these dates." },
    );
}

async function assertReservationRoomsAvailable(t: Db, resId: unknown) {
  const rooms = await t.query(
    "SELECT res_room_id, room_no, check_in_date, check_out_date FROM bookinn.reservation_room WHERE res_id = $1",
    [resId],
  );
  for (const r of rooms.rows) await assertRoomAvailable(t, r.room_no, r.check_in_date, r.check_out_date, r.res_room_id);
}

/** Total cost of a reservation = Σ room price × nights (prices from ROOM_DETAILS). */
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

/** Amount due after the (single) loyalty discount (SRS §3.3 Loyalty). */
export function amountDue(totalCents: number, maxPriceCents: number, discount: string) {
  if (discount === "12% Discount") return totalCents - Math.round((totalCents * 12) / 100);
  if (discount === "Free Night") return Math.max(0, totalCents - maxPriceCents);
  return totalCents;
}

async function loyaltyAccountFor(t: Db, resId: unknown) {
  const r = await t.query(
    `SELECT l.lyl_id, l.total_pts FROM bookinn.loyalty_acc l
       JOIN bookinn.reservation r ON r.cus_id = l.cus_id WHERE r.res_id = $1`,
    [resId],
  );
  return r.rows[0] as { lyl_id: number; total_pts: number } | undefined;
}

/** Validates amount/discount and derives PTS_EARN / PTS_SPEND server-side. */
async function preparePayment(t: Db, resId: unknown, v: Values, discountChanged: boolean): Promise<Values> {
  const discount = String(v.discount_type ?? "NONE");
  const cost = await reservationCost(t, resId);
  if (cost.rooms === 0)
    throw new AppError("validation", `Reservation #${resId} has no rooms yet; add a reservation room before recording payment.`);

  const account = await loyaltyAccountFor(t, resId);
  const spend = DISCOUNT_POINTS[discount];
  if (spend > 0) {
    if (!account)
      throw new AppError("validation", "Loyalty discounts require the guest to have a loyalty account.", {
        discount_type: "No loyalty account.",
      });
    if (discountChanged && account.total_pts < spend)
      throw new AppError("validation", `${discount} needs ${spend} points; the account has ${account.total_pts}.`, {
        discount_type: "Not enough points.",
      });
  }

  const due = amountDue(cost.totalCents, cost.maxPriceCents, discount);
  const amt = toCents(v.pay_amt);
  if (amt > due)
    throw new AppError("validation", `Overpayment: ${peso(amt)} exceeds the amount due of ${peso(due)}.`, {
      pay_amt: `Amount due is ${peso(due)}.`,
    });
  if (amt < due)
    throw new AppError(
      "validation",
      `Reservations are paid once, in full (one-time payment rule). Amount due is ${peso(due)}.`,
      { pay_amt: `Amount due is ${peso(due)}.` },
    );

  // Cannot earn and spend in the same transaction; earning needs a loyalty account.
  const earn = spend === 0 && account ? pointsEarned(amt) : 0;
  return { ...v, pts_spend: spend, pts_earn: earn };
}

async function setReservationStatus(t: Db, actor: Actor, res: Row, status: string) {
  const r = await t.query("UPDATE bookinn.reservation SET booking_status = $2 WHERE res_id = $1 RETURNING *", [
    res.res_id,
    status,
  ]);
  const e = ENTITIES.reservation;
  await writeAudit(t, actor, "UPDATE", e, r.rows[0], describe(e, res, ["booking_status"]), describe(e, r.rows[0], ["booking_status"]));
}

async function activeAdminsExcept(t: Db, staffId: unknown) {
  const r = await t.query(
    "SELECT count(*)::int AS n FROM bookinn.staff WHERE role = 'Database Administrator' AND is_active AND staff_id <> $1",
    [staffId],
  );
  return Number(r.rows[0].n);
}

// ---------------------------------------------------------------- hooks
export async function beforeCreate(t: Db, e: EntityDef, v: Values, _actor: Actor): Promise<Values> {
  switch (e.key) {
    case "reservation":
      return { ...v, booking_status: "Booked" };
    case "reservation_room": {
      const res = await lockReservation(t, v.res_id);
      assertEditableBooking(res, await hasPayment(t, v.res_id));
      assertDates(v);
      await assertRoomAvailable(t, v.room_no, v.check_in_date, v.check_out_date);
      return v;
    }
    case "payment": {
      const res = await lockReservation(t, v.res_id);
      if (res.booking_status !== "Booked")
        throw new AppError("conflict", `Reservation #${res.res_id} is ${res.booking_status}; payments can only be recorded for Booked reservations.`);
      return preparePayment(t, v.res_id, v, true);
    }
    case "cancellation": {
      const res = await lockReservation(t, v.res_id);
      if (res.booking_status !== "Booked")
        throw new AppError("conflict", `Only Booked reservations can be cancelled; #${res.res_id} is ${res.booking_status}.`);
      return v;
    }
    case "staff":
      return { ...v, pass: await bcrypt.hash(String(v.pass), BCRYPT_COST) };
    default:
      return v;
  }
}

export async function afterCreate(t: Db, e: EntityDef, row: Row, actor: Actor) {
  if (e.key === "payment") {
    // SRS: a traceable receipt is issued for every payment (email delivery deferred).
    const r = await t.query("INSERT INTO bookinn.receipt (pay_id) VALUES ($1) RETURNING *", [row.pay_id]);
    await writeAudit(t, actor, "INSERT", ENTITIES.receipt, r.rows[0], null, describe(ENTITIES.receipt, r.rows[0]));
  }
  if (e.key === "cancellation") {
    const res = await lockReservation(t, row.res_id);
    await setReservationStatus(t, actor, res, "Cancelled");
  }
}

export async function beforeUpdate(t: Db, e: EntityDef, old: Row, v: Values, actor: Actor): Promise<Values> {
  switch (e.key) {
    case "reservation": {
      const res = await lockReservation(t, old.res_id);
      if (res.booking_status === "Cancelled")
        throw new AppError("conflict", "Cancelled reservations are read-only. Delete the cancellation record to reinstate it.");
      if (String(v.cus_id) !== String(old.cus_id) && (await hasPayment(t, old.res_id)))
        throw new AppError("conflict", "This reservation has been paid, so its guest can no longer be changed (FR-14).");
      if (old.booking_status === "Completed" && v.booking_status === "Booked")
        await assertReservationRoomsAvailable(t, old.res_id);
      return v;
    }
    case "reservation_room": {
      const res = await lockReservation(t, old.res_id);
      assertEditableBooking(res, await hasPayment(t, old.res_id));
      assertDates(v);
      await assertRoomAvailable(t, v.room_no, v.check_in_date, v.check_out_date, old.res_room_id);
      return v;
    }
    case "payment": {
      await lockReservation(t, old.res_id);
      return preparePayment(t, old.res_id, v, v.discount_type !== old.discount_type);
    }
    case "staff": {
      const next = { ...v };
      if (next.pass !== undefined) next.pass = await bcrypt.hash(String(next.pass), BCRYPT_COST);
      const losesAdmin = old.role === "Database Administrator" && (next.role !== "Database Administrator" || next.is_active === false);
      if (losesAdmin && Number(old.staff_id) === actor.staffId)
        throw new AppError("conflict", "You cannot deactivate or demote your own administrator account.");
      if (losesAdmin && old.is_active && (await activeAdminsExcept(t, old.staff_id)) === 0)
        throw new AppError("conflict", "At least one active Database Administrator must remain.");
      return next;
    }
    default:
      return v;
  }
}

export async function beforeDelete(t: Db, e: EntityDef, old: Row, actor: Actor) {
  switch (e.key) {
    case "reservation_room": {
      const res = await lockReservation(t, old.res_id);
      assertEditableBooking(res, await hasPayment(t, old.res_id));
      return;
    }
    case "staff":
      if (Number(old.staff_id) === actor.staffId) throw new AppError("conflict", "You cannot delete your own account.");
      if (old.role === "Database Administrator" && old.is_active && (await activeAdminsExcept(t, old.staff_id)) === 0)
        throw new AppError("conflict", "At least one active Database Administrator must remain.");
      return;
  }
}

export async function afterDelete(t: Db, e: EntityDef, old: Row, actor: Actor) {
  if (e.key === "cancellation") {
    // Undoing a cancellation reinstates the booking only if its rooms are still free.
    const res = await lockReservation(t, old.res_id);
    if (res.booking_status === "Cancelled") {
      await assertReservationRoomsAvailable(t, old.res_id);
      await setReservationStatus(t, actor, res, "Booked");
    }
  }
}

function assertDates(v: Values) {
  if (String(v.check_out_date) <= String(v.check_in_date))
    throw new AppError("validation", "Check-out date must be after check-in date.", {
      check_out_date: "Must be after check-in.",
    });
}
