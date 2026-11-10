/** Dashboard figures and room availability, computed from the database (FR-12). */
import type { Db } from "./db/types";
import type { Actor } from "./audit";
import { assertCan } from "./crud";
import { ENTITIES } from "./entities";
import { hotelToday, addDays } from "./dates";
import { toCents } from "./money";

export type RoomAvailability = {
  room_no: number;
  room_type_id: string;
  room_type: string;
  room_view: string;
  room_price: string;
  available: boolean;
  /** Reservation holding the room for part of the range, if any. */
  blocked_by: number | null;
};

/**
 * Rooms free for the whole stay [from, to), computed from dates and check-in
 * and check-out events (SRS v2 FR-13, §3.3 Room Availability): a Booked or
 * Checked-In reservation's room blocks its dates until it is checked out, and
 * a checked-in room past its check-out date stays blocked through today.
 * Same rule as the database's bookinn.assert_room_free.
 */
export async function roomAvailability(db: Db, actor: Actor, from: string, to: string, today = hotelToday()): Promise<RoomAvailability[]> {
  assertCan(actor, ENTITIES.room, "read");
  const r = await db.query<RoomAvailability>(
    `SELECT ro.room_no, ro.room_type_id, d.room_type::text, d.room_view::text, d.room_price::text,
            b.res_id IS NULL AS available, b.res_id AS blocked_by
       FROM bookinn.room ro
       JOIN bookinn.room_details d ON d.room_type_id = ro.room_type_id
       LEFT JOIN LATERAL (
            SELECT rr.res_id FROM bookinn.reservation_room rr
              JOIN bookinn.reservation r ON r.res_id = rr.res_id
             WHERE rr.room_no = ro.room_no AND r.booking_status IN ('Booked', 'Checked-In')
               AND rr.actual_check_out IS NULL
               AND rr.check_in_date < $2::date
               AND CASE WHEN rr.actual_check_in IS NOT NULL THEN GREATEST(rr.check_out_date, $3::date + 1)
                        ELSE rr.check_out_date END > $1::date
             LIMIT 1) b ON true
      ORDER BY ro.room_no`,
    [from, to, today],
  );
  return r.rows;
}

export interface DashboardStats {
  today: string;
  customers: number;
  rooms: number;
  availableTonight: number;
  inHouse: number;
  upcoming: number;
  booked: number;
  checkedIn: number;
  completed: number;
  cancelled: number;
  noShow: number;
  payments: number;
  revenueCents: number;
  revenueThisMonthCents: number;
  loyaltyAccounts: number;
  loyaltyPoints: number;
  nextArrivals: { res_id: number; cus_name: string; room_no: number; check_in_date: string; check_out_date: string }[];
}

export async function dashboardStats(db: Db, actor: Actor, today = hotelToday()): Promise<DashboardStats> {
  assertCan(actor, ENTITIES.reservation, "read");
  const one = async (sql: string, params: unknown[] = []) => (await db.query<{ v: string | null }>(sql, params)).rows[0].v;
  const monthStart = `${today.slice(0, 7)}-01`;
  const [customers, rooms, inHouse, upcoming, statuses, pay, payMonth, loyalty, arrivals, avail] = await Promise.all([
    one("SELECT count(*)::text AS v FROM bookinn.customer"),
    one("SELECT count(*)::text AS v FROM bookinn.room"),
    // In-house = rooms checked in and not yet checked out (check-in/out events, not dates).
    one(
      `SELECT count(*)::text AS v FROM bookinn.reservation_room rr JOIN bookinn.reservation r ON r.res_id = rr.res_id
        WHERE r.booking_status = 'Checked-In' AND rr.actual_check_in IS NOT NULL AND rr.actual_check_out IS NULL`,
    ),
    one(
      `SELECT count(*)::text AS v FROM bookinn.reservation r
        WHERE r.booking_status = 'Booked' AND (SELECT min(check_in_date) FROM bookinn.reservation_room WHERE res_id = r.res_id) > $1::date`,
      [today],
    ),
    db.query<{ booking_status: string; n: number }>(
      "SELECT booking_status::text, count(*)::int AS n FROM bookinn.reservation GROUP BY 1",
    ),
    db.query<{ n: number; total: string }>("SELECT count(*)::int AS n, COALESCE(sum(pay_amt), 0)::text AS total FROM bookinn.payment"),
    one("SELECT COALESCE(sum(pay_amt), 0)::text AS v FROM bookinn.payment WHERE pay_date >= $1::date AND pay_date <= $2::date", [
      monthStart,
      today,
    ]),
    db.query<{ n: number; pts: number }>("SELECT count(*)::int AS n, COALESCE(sum(total_pts), 0)::int AS pts FROM bookinn.loyalty_acc"),
    db.query<DashboardStats["nextArrivals"][number]>(
      `SELECT r.res_id, c.cus_name, rr.room_no, rr.check_in_date, rr.check_out_date
         FROM bookinn.reservation r
         JOIN bookinn.customer c ON c.cus_id = r.cus_id
         JOIN bookinn.reservation_room rr ON rr.res_id = r.res_id
        WHERE r.booking_status IN ('Booked', 'Checked-In') AND rr.actual_check_out IS NULL AND rr.check_out_date > $1::date
        ORDER BY rr.check_in_date, rr.room_no LIMIT 8`,
      [today],
    ),
    roomAvailability(db, actor, today, addDays(today, 1), today),
  ]);
  const byStatus = Object.fromEntries(statuses.rows.map((s) => [s.booking_status, Number(s.n)]));
  return {
    today,
    customers: Number(customers),
    rooms: Number(rooms),
    availableTonight: avail.filter((a) => a.available).length,
    inHouse: Number(inHouse),
    upcoming: Number(upcoming),
    booked: byStatus.Booked ?? 0,
    checkedIn: byStatus["Checked-In"] ?? 0,
    completed: byStatus.Completed ?? 0,
    cancelled: byStatus.Cancelled ?? 0,
    noShow: byStatus["No-Show"] ?? 0,
    payments: Number(pay.rows[0].n),
    revenueCents: toCents(pay.rows[0].total),
    revenueThisMonthCents: toCents(payMonth ?? "0"),
    loyaltyAccounts: Number(loyalty.rows[0].n),
    loyaltyPoints: Number(loyalty.rows[0].pts),
    nextArrivals: arrivals.rows,
  };
}

// ---------------------------------------------------------------- trends (dashboard charts)
export interface DayPoint {
  date: string;
  /** Sum of payments recorded that day (Initial and Checkout). */
  paymentsCents: number;
  /** Bookings made that day (counted by their Initial payment). */
  bookings: number;
  /** Guest cancellations that day. */
  cancellations: number;
}

export interface DashboardTrends {
  days: DayPoint[];
  bookings7: number;
  bookingsPrev7: number;
  payments7Cents: number;
  paymentsPrev7Cents: number;
  revenueLastMonthCents: number;
  arrivalsToday: number;
  arrivalsCheckedIn: number;
  departuresToday: number;
  departuresCheckedOut: number;
  /** Rooms checked in and not yet checked out right now. */
  occupiedNow: number;
}

/**
 * Last-7-days series and today's arrivals/departures for the dashboard. Everything is
 * computed from existing records (payments, cancellations, reserved rooms and their
 * check-in/out events); nothing new is stored.
 */
export async function dashboardTrends(db: Db, actor: Actor, today = hotelToday()): Promise<DashboardTrends> {
  assertCan(actor, ENTITIES.reservation, "read");
  const from = addDays(today, -6);
  const prevFrom = addDays(today, -13);
  const prevTo = addDays(today, -7);
  const monthStart = `${today.slice(0, 7)}-01`;
  const lastMonthStart = `${addDays(monthStart, -1).slice(0, 7)}-01`;

  const [pay, can, prev, lastMonth, arr, dep, occ] = await Promise.all([
    db.query<{ d: string; total: string; bookings: number }>(
      `SELECT pay_date::text AS d, sum(pay_amt)::text AS total, count(*) FILTER (WHERE pay_type = 'Initial')::int AS bookings
         FROM bookinn.payment WHERE pay_date BETWEEN $1::date AND $2::date GROUP BY 1`,
      [from, today],
    ),
    db.query<{ d: string; n: number }>(
      "SELECT cancel_date::text AS d, count(*)::int AS n FROM bookinn.cancellation WHERE cancel_date BETWEEN $1::date AND $2::date GROUP BY 1",
      [from, today],
    ),
    db.query<{ total: string; bookings: number }>(
      `SELECT COALESCE(sum(pay_amt), 0)::text AS total, count(*) FILTER (WHERE pay_type = 'Initial')::int AS bookings
         FROM bookinn.payment WHERE pay_date BETWEEN $1::date AND $2::date`,
      [prevFrom, prevTo],
    ),
    db.query<{ total: string }>(
      "SELECT COALESCE(sum(pay_amt), 0)::text AS total FROM bookinn.payment WHERE pay_date >= $1::date AND pay_date < $2::date",
      [lastMonthStart, monthStart],
    ),
    db.query<{ total: number; done: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE rr.actual_check_in IS NOT NULL)::int AS done
         FROM bookinn.reservation_room rr JOIN bookinn.reservation r ON r.res_id = rr.res_id
        WHERE rr.check_in_date = $1::date AND r.booking_status IN ('Booked', 'Checked-In', 'Completed')`,
      [today],
    ),
    db.query<{ total: number; done: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE rr.actual_check_out IS NOT NULL)::int AS done
         FROM bookinn.reservation_room rr JOIN bookinn.reservation r ON r.res_id = rr.res_id
        WHERE rr.check_out_date = $1::date AND rr.actual_check_in IS NOT NULL AND r.booking_status IN ('Checked-In', 'Completed')`,
      [today],
    ),
    db.query<{ n: number }>(
      `SELECT count(DISTINCT rr.room_no)::int AS n FROM bookinn.reservation_room rr JOIN bookinn.reservation r ON r.res_id = rr.res_id
        WHERE r.booking_status = 'Checked-In' AND rr.actual_check_in IS NOT NULL AND rr.actual_check_out IS NULL`,
    ),
  ]);

  const payBy = new Map(pay.rows.map((r) => [r.d, r]));
  const canBy = new Map(can.rows.map((r) => [r.d, Number(r.n)]));
  const days: DayPoint[] = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(from, i);
    const p = payBy.get(date);
    return { date, paymentsCents: p ? toCents(p.total) : 0, bookings: p ? Number(p.bookings) : 0, cancellations: canBy.get(date) ?? 0 };
  });
  return {
    days,
    bookings7: days.reduce((a, d) => a + d.bookings, 0),
    bookingsPrev7: Number(prev.rows[0].bookings),
    payments7Cents: days.reduce((a, d) => a + d.paymentsCents, 0),
    paymentsPrev7Cents: toCents(prev.rows[0].total),
    revenueLastMonthCents: toCents(lastMonth.rows[0].total),
    arrivalsToday: Number(arr.rows[0].total),
    arrivalsCheckedIn: Number(arr.rows[0].done),
    departuresToday: Number(dep.rows[0].total),
    departuresCheckedOut: Number(dep.rows[0].done),
    occupiedNow: Number(occ.rows[0].n),
  };
}
