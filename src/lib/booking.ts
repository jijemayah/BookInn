/**
 * Front Desk booking flow (FR-13 – FR-18, SRS §3.3 Reservations and Payments).
 *
 * A reservation, its reserved rooms, its single full payment, the receipt and
 * the loyalty balance change are written in ONE transaction, so a reservation
 * can never exist unpaid and points can never be applied twice. All amounts
 * are computed here from ROOM_DETAILS prices; nothing the browser sends about
 * money is trusted except the amount tendered, which must equal the amount due.
 */
import { z } from "zod";
import type { Db } from "./db/types";
import { ENTITIES, ENUMS } from "./entities";
import { AppError } from "./errors";
import { setActor, type Actor } from "./audit";
import { assertCan, mapDbError } from "./crud";
import { assertRoomAvailable, lockReservation } from "./rules";
import { amountDue, DISCOUNT_POINTS, pointsFor, toCents, peso, type Discount } from "./money";
import { hotelToday, nightsBetween } from "./dates";
import { isMoney, isRealDate } from "./validation";

export interface StayInput {
  room_no: string;
  check_in_date: string;
  check_out_date: string;
}
export interface BookingInput {
  cus_id: string;
  stays: StayInput[];
  discount_type: string;
  pay_method?: string;
  pay_amt?: string;
}

export interface QuoteLine {
  room_no: number;
  room_type: string;
  room_view: string;
  check_in_date: string;
  check_out_date: string;
  nights: number;
  nightlyCents: number;
  subtotalCents: number;
}
export interface Quote {
  customer: { cus_id: number; cus_name: string; cus_email: string };
  loyalty: { lyl_id: number; total_pts: number } | null;
  lines: QuoteLine[];
  discount: Discount;
  totalCents: number;
  discountCents: number;
  dueCents: number;
  pointsEarn: number;
  pointsSpend: number;
}

const inputSchema = z.object({
  cus_id: z.string().trim().regex(/^\d{1,10}$/, "Select a customer."),
  discount_type: z.enum(ENUMS.discount_type, { message: "Choose a discount option." }),
  stays: z
    .array(
      z.object({
        room_no: z.string().trim().regex(/^\d{1,10}$/, "Select a room."),
        check_in_date: z.string().trim().refine(isRealDate, "Enter a valid check-in date."),
        check_out_date: z.string().trim().refine(isRealDate, "Enter a valid check-out date."),
      }),
    )
    .min(1, "Select at least one room.")
    .max(20, "At most 20 rooms per reservation."),
});

function fieldErrors(err: z.ZodError, input: BookingInput) {
  const out: Record<string, string> = {};
  for (const i of err.issues) {
    let key = String(i.path[0]);
    if (i.path[0] === "stays") {
      // Attach the message to the room's own date field, e.g. in_205 / out_205.
      const room = input.stays?.[Number(i.path[1])]?.room_no;
      const field = i.path[2];
      key = i.path.length > 2 && room ? `${field === "check_in_date" ? "in" : field === "check_out_date" ? "out" : "room"}_${room}` : "stays";
    }
    out[key] ??= i.message;
  }
  return out;
}

function parse(input: BookingInput) {
  const r = inputSchema.safeParse(input);
  if (!r.success) throw new AppError("validation", "Please fix the highlighted fields.", fieldErrors(r.error, input));
  return r.data;
}

/** Validates the request and prices it. With `lock`, rows are locked for the booking transaction. */
async function price(t: Db, input: ReturnType<typeof parse>, today: string, lock: boolean): Promise<Quote> {
  const cus = await t.query<{ cus_id: number; cus_name: string; cus_email: string }>(
    `SELECT cus_id, cus_name, cus_email FROM bookinn.customer WHERE cus_id = $1${lock ? " FOR SHARE" : ""}`,
    [input.cus_id],
  );
  if (!cus.rows[0])
    throw new AppError("validation", "A reservation needs an existing customer. Add the guest first.", { cus_id: "Customer not found." });

  const lines: QuoteLine[] = [];
  for (const s of input.stays) {
    if (s.check_out_date <= s.check_in_date)
      throw new AppError("validation", `Room ${s.room_no}: check-out must be after check-in.`, { [`out_${s.room_no}`]: "Must be after check-in." });
    if (s.check_in_date < today)
      throw new AppError("validation", `Room ${s.room_no}: bookings cannot start in the past (today is ${today}).`, {
        [`in_${s.room_no}`]: `On or after ${today}.`,
      });
    const dup = lines.find(
      (l) => String(l.room_no) === s.room_no && l.check_in_date < s.check_out_date && l.check_out_date > s.check_in_date,
    );
    if (dup) throw new AppError("validation", `Room ${s.room_no} is selected twice for overlapping dates.`, { stays: "Duplicate room." });

    const room = await t.query<{ room_no: number; room_type: string; room_view: string; room_price: string }>(
      `SELECT r.room_no, d.room_type, d.room_view, d.room_price::text AS room_price
         FROM bookinn.room r JOIN bookinn.room_details d ON d.room_type_id = r.room_type_id
        WHERE r.room_no = $1`,
      [s.room_no],
    );
    if (!room.rows[0]) throw new AppError("validation", `Room ${s.room_no} does not exist.`, { stays: "Unknown room." });
    // Locks the ROOM row inside the booking transaction; read-only check for quotes.
    await assertRoomAvailable(t, s.room_no, s.check_in_date, s.check_out_date);
    const nights = nightsBetween(s.check_in_date, s.check_out_date);
    const nightlyCents = toCents(room.rows[0].room_price);
    lines.push({
      room_no: room.rows[0].room_no,
      room_type: room.rows[0].room_type,
      room_view: room.rows[0].room_view,
      check_in_date: s.check_in_date,
      check_out_date: s.check_out_date,
      nights,
      nightlyCents,
      subtotalCents: nights * nightlyCents,
    });
  }

  const loy = await t.query<{ lyl_id: number; total_pts: number }>(
    `SELECT lyl_id, total_pts FROM bookinn.loyalty_acc WHERE cus_id = $1${lock ? " FOR UPDATE" : ""}`,
    [input.cus_id],
  );
  const loyalty = loy.rows[0] ?? null;
  const discount = input.discount_type as Discount;
  const need = DISCOUNT_POINTS[discount];
  if (need > 0 && !loyalty)
    throw new AppError("validation", "Loyalty discounts need a loyalty account. Open one for the guest first.", {
      discount_type: "No loyalty account.",
    });
  if (need > 0 && loyalty!.total_pts < need)
    throw new AppError("validation", `${discount} needs ${need} points; the guest has ${loyalty!.total_pts}.`, {
      discount_type: "Not enough points.",
    });

  const totalCents = lines.reduce((a, l) => a + l.subtotalCents, 0);
  const maxNightly = Math.max(...lines.map((l) => l.nightlyCents));
  const dueCents = amountDue(totalCents, maxNightly, discount);
  const { earn, spend } = pointsFor(dueCents, discount, !!loyalty);
  return {
    customer: cus.rows[0],
    loyalty,
    lines,
    discount,
    totalCents,
    discountCents: totalCents - dueCents,
    dueCents,
    pointsEarn: earn,
    pointsSpend: spend,
  };
}

/** Front Desk and the Database Administrator book (permission table: Reservation, Create). */
const assertBookingRole = (actor: Actor) => assertCan(actor, ENTITIES.reservation, "create");

/** Review step: checks availability and computes the amount due without saving anything. */
export async function quoteBooking(db: Db, actor: Actor, input: BookingInput, today = hotelToday()): Promise<Quote> {
  assertBookingRole(actor);
  const data = parse(input);
  try {
    return await db.tx((t) => price(t, data, today, false));
  } catch (err) {
    mapDbError(err);
  }
}

/** Confirm step: saves reservation + rooms + payment + receipt + points atomically. */
export async function createBooking(db: Db, actor: Actor, input: BookingInput, today = hotelToday()) {
  assertBookingRole(actor);
  const data = parse(input);
  const method = String(input.pay_method ?? "");
  if (!(ENUMS.pay_method as readonly string[]).includes(method))
    throw new AppError("validation", "Choose the payment method.", { pay_method: "Required." });
  const amt = String(input.pay_amt ?? "").trim();
  if (!isMoney(amt)) throw new AppError("validation", "Enter the amount paid, e.g. 3000 or 3000.00.", { pay_amt: "Invalid amount." });

  try {
    return await db.tx(async (t) => {
      await setActor(t, actor);
      const quote = await price(t, data, today, true);
      if (toCents(amt) !== quote.dueCents)
        throw new AppError(
          "validation",
          `Reservations are paid once, in full. The amount paid must be exactly ${peso(quote.dueCents)}.`,
          { pay_amt: `Amount due is ${peso(quote.dueCents)}.` },
        );

      const res = await t.query<{ res_id: number }>(
        "INSERT INTO bookinn.reservation (cus_id, booking_status) VALUES ($1, 'Booked') RETURNING res_id",
        [data.cus_id],
      );
      const resId = res.rows[0].res_id;
      for (const l of quote.lines)
        await t.query(
          "INSERT INTO bookinn.reservation_room (res_id, room_no, check_in_date, check_out_date) VALUES ($1, $2, $3, $4)",
          [resId, l.room_no, l.check_in_date, l.check_out_date],
        );

      if (quote.loyalty && quote.pointsEarn - quote.pointsSpend !== 0)
        await t.query("UPDATE bookinn.loyalty_acc SET total_pts = total_pts + $2 WHERE lyl_id = $1", [
          quote.loyalty.lyl_id,
          quote.pointsEarn - quote.pointsSpend,
        ]);

      const pay = await t.query<{ pay_id: number }>(
        `INSERT INTO bookinn.payment (res_id, pay_method, pay_date, pay_amt, pts_earn, pts_spend, discount_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING pay_id`,
        [resId, method, today, amt, quote.pointsEarn, quote.pointsSpend, quote.discount],
      );
      const payId = pay.rows[0].pay_id;
      const rct = await t.query<{ rct_no: number }>("INSERT INTO bookinn.receipt (pay_id) VALUES ($1) RETURNING rct_no", [payId]);
      return { resId, payId, rctNo: rct.rows[0].rct_no, quote };
    });
  } catch (err) {
    mapDbError(err);
  }
}

/** FR-14 cancel: creates the CANCELLATION record and sets the status, in one transaction. No refund. */
export async function cancelReservation(db: Db, actor: Actor, resId: string | number, today = hotelToday()) {
  assertCan(actor, ENTITIES.cancellation, "create");
  try {
    return await db.tx(async (t) => {
      await setActor(t, actor);
      const res = await lockReservation(t, resId);
      if (res.booking_status !== "Booked")
        throw new AppError("conflict", `Only Booked reservations can be cancelled; #${res.res_id} is ${res.booking_status}.`);
      const c = await t.query<{ cancel_id: number }>(
        "INSERT INTO bookinn.cancellation (res_id, cancel_date) VALUES ($1, $2) RETURNING cancel_id",
        [res.res_id, today],
      );
      await t.query("UPDATE bookinn.reservation SET booking_status = 'Cancelled' WHERE res_id = $1", [res.res_id]);
      return { cancelId: c.rows[0].cancel_id };
    });
  } catch (err) {
    mapDbError(err);
  }
}
