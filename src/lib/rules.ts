/**
 * SRS §3.3 business rules for the generic record screens. Each hook runs
 * inside the same transaction as the write it guards, so a rejected rule
 * leaves no trace. Front Desk bookings go through ./booking.ts instead; the
 * reservation/payment hooks here cover Database Administrator corrections
 * (§1.4: "Errors in logged records are corrected only by the Database
 * Administrator"). Every change is recorded by the audit triggers.
 */
import bcrypt from "bcryptjs";
import type { Db, Row } from "./db/types";
import type { EntityDef } from "./entities";
import { AppError } from "./errors";
import type { Actor } from "./audit";
import { amountDue, peso, pointsFor, toCents, type Discount } from "./money";
import { hotelToday } from "./dates";

type Values = Record<string, unknown>;
export const BCRYPT_COST = Number(process.env.BCRYPT_COST ?? 12);

// ---------------------------------------------------------------- shared lookups
export async function lockReservation(t: Db, resId: unknown): Promise<Row> {
  const r = await t.query("SELECT * FROM bookinn.reservation WHERE res_id = $1 FOR UPDATE", [resId]);
  if (!r.rows[0]) throw new AppError("validation", `Reservation #${resId} does not exist.`, { res_id: "Not found." });
  return r.rows[0];
}

/**
 * Friendly double-booking check (the database trigger enforces the same rule).
 * Only reservations still "Booked" count; Cancelled and Completed ones free the
 * room. Stays are half-open [check-in, check-out), so back-to-back is allowed.
 */
export async function assertRoomAvailable(
  t: Db,
  roomNo: unknown,
  checkIn: unknown,
  checkOut: unknown,
  opts: { excludeResRoomId?: unknown; resId?: unknown } = {},
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
        AND rr.res_id <> COALESCE($5::int, -1)
      LIMIT 1`,
    [roomNo, checkIn, checkOut, opts.excludeResRoomId ?? null, opts.resId ?? null],
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
  for (const r of rooms.rows)
    await assertRoomAvailable(t, r.room_no, r.check_in_date, r.check_out_date, { excludeResRoomId: r.res_room_id, resId });
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

/**
 * Validates a payment against the server-computed amount due and derives
 * PTS_EARN / PTS_SPEND. `previous` is the stored payment when correcting one.
 */
async function preparePayment(t: Db, resId: unknown, v: Values, previous?: Row): Promise<Values> {
  const discount = String(v.discount_type ?? "NONE") as Discount;
  const cost = await reservationCost(t, resId);
  if (cost.rooms === 0)
    throw new AppError("validation", `Reservation #${resId} has no rooms; add a reserved room before recording payment.`);

  const account = await lockLoyaltyFor(t, resId);
  const due = amountDue(cost.totalCents, cost.maxPriceCents, discount);
  const amt = toCents(v.pay_amt);
  if (amt !== due)
    throw new AppError(
      "validation",
      `The payment must equal the amount due of ${peso(due)} (one full payment; no partial or over-payment).`,
      { pay_amt: `Amount due is ${peso(due)}.` },
    );

  const { earn, spend } = pointsFor(amt, discount, !!account);
  if (spend > 0 && !account)
    throw new AppError("validation", "Loyalty discounts require the guest to have a loyalty account.", {
      discount_type: "No loyalty account.",
    });
  const delta = earn - spend - (Number(previous?.pts_earn ?? 0) - Number(previous?.pts_spend ?? 0));
  if (account) {
    if (account.total_pts + delta < 0)
      throw new AppError("validation", `${discount} needs ${spend} points; the account has ${account.total_pts}.`, {
        discount_type: "Not enough points.",
      });
    await adjustPoints(t, account.lyl_id, delta);
  }
  return { ...v, pts_spend: spend, pts_earn: earn };
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
      if (res.booking_status === "Cancelled")
        throw new AppError("conflict", `Reservation #${res.res_id} is Cancelled; no payment can be recorded.`);
      const values = await preparePayment(t, v.res_id, v);
      return values;
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

export async function afterCreate(t: Db, e: EntityDef, row: Row) {
  if (e.key === "payment") {
    // SRS: a traceable receipt is issued for every payment.
    await t.query("INSERT INTO bookinn.receipt (pay_id) VALUES ($1)", [row.pay_id]);
  }
  if (e.key === "cancellation") {
    await t.query("UPDATE bookinn.reservation SET booking_status = 'Cancelled' WHERE res_id = $1", [row.res_id]);
  }
}

export async function beforeUpdate(t: Db, e: EntityDef, old: Row, v: Values, actor: Actor): Promise<Values> {
  switch (e.key) {
    case "reservation": {
      const res = await lockReservation(t, old.res_id);
      if (res.booking_status === "Cancelled")
        throw new AppError("conflict", "Cancelled reservations are read-only. Delete the cancellation record to reinstate it.");
      if (old.booking_status !== "Booked" && v.booking_status === "Booked") await assertReservationRoomsAvailable(t, old.res_id);
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
      await lockReservation(t, old.res_id);
      return preparePayment(t, old.res_id, v, old);
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
      // Removing a wrongly entered payment (administrator correction) undoes its points.
      await lockReservation(t, old.res_id);
      const account = await lockLoyaltyFor(t, old.res_id);
      const delta = Number(old.pts_spend) - Number(old.pts_earn);
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
    case "staff":
      if (Number(old.staff_id) === actor.staffId) throw new AppError("conflict", "You cannot delete your own account.");
      if (old.role === "Database Administrator" && old.is_active === "Yes" && (await activeAdminsExcept(t, old.staff_id)) === 0)
        throw new AppError("conflict", "At least one active Database Administrator must remain.");
      return;
  }
}

export async function afterDelete(t: Db, e: EntityDef, old: Row) {
  if (e.key === "cancellation") {
    // Undoing a cancellation reinstates the booking only if its rooms are still free.
    const res = await lockReservation(t, old.res_id);
    if (res.booking_status === "Cancelled") {
      await assertReservationRoomsAvailable(t, old.res_id);
      await t.query("UPDATE bookinn.reservation SET booking_status = 'Booked' WHERE res_id = $1", [old.res_id]);
    }
  }
}
