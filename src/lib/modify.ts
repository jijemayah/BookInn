/**
 * Reservation modification (SRS v2 FR-19, §3.3 Modification, Modification
 * Pricing, Modification Payment).
 *
 * Only a Booked reservation, only until the 48-hour cutoff (earliest check-in
 * at 14:00 minus 48 hours). Front Desk may change a room row's room or dates,
 * add rows and remove rows; the guest cannot change. Each changed row is
 * re-priced as a whole at its room type's rate; the difference between the
 * new and old totals of the changed rows is posted as ONE Modification charge
 * (positive or negative) on the reservation, Unpaid until check-out, with no
 * loyalty discount. Unchanged rows are left out of the pricing.
 *
 * The caller sends the full desired list of rooms: rows with `res_room_id`
 * are existing rows (changed or not), rows without it are added, and
 * existing rows that are missing are removed.
 */
import { z } from "zod";
import type { Db } from "./db/types";
import { AppError } from "./errors";
import { setActor, setHotelDay, type Actor } from "./audit";
import { mapDbError } from "./crud";
import { assertFrontDesk, assertRoomAvailable, earliestCheckIn, lockReservation, roomPriceCents } from "./rules";
import { beforeCutoff, cutoffFor, hotelNow, hotelToday, nightsBetween } from "./dates";
import { peso } from "./money";
import { isRealDate } from "./validation";

export interface ModifyStayInput {
  res_room_id?: string | number | null;
  room_no: string | number;
  check_in_date: string;
  check_out_date: string;
}

export interface ModificationResult {
  resId: number;
  changed: number[];
  added: number[];
  removed: number[];
  /** New total − old total of the changed rows, in centavos. */
  differenceCents: number;
  chargeId: number | null;
}

const schema = z
  .array(
    z.object({
      res_room_id: z.union([z.string(), z.number()]).nullish(),
      room_no: z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^\d{1,10}$/, "Select a room.")),
      check_in_date: z.string().trim().refine(isRealDate, "Enter a valid check-in date."),
      check_out_date: z.string().trim().refine(isRealDate, "Enter a valid check-out date."),
    }),
  )
  .min(1, "A reservation keeps at least one room.")
  .max(20, "At most 20 rooms per reservation.");

type OldRow = {
  res_room_id: number;
  room_no: number;
  check_in_date: string;
  check_out_date: string;
};

const rowCost = async (t: Db, r: { room_no: number | string; check_in_date: string; check_out_date: string }) =>
  nightsBetween(r.check_in_date, r.check_out_date) * (await roomPriceCents(t, r.room_no));

export async function modifyReservation(
  db: Db,
  actor: Actor,
  resId: string | number,
  input: ModifyStayInput[],
  now: Date = new Date(),
): Promise<ModificationResult> {
  assertFrontDesk(actor, "edit reservations");
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new AppError("validation", parsed.error.issues[0]?.message ?? "Check the rooms and dates.");
  const stays = parsed.data;
  const today = hotelToday(now);
  const nowLocal = hotelNow(now);

  try {
    return await db.tx(async (t) => {
      await setActor(t, actor);
      await setHotelDay(t, today);
      const res = await lockReservation(t, resId);
      if (res.booking_status !== "Booked")
        throw new AppError("conflict", `Only Booked reservations can be edited; #${res.res_id} is ${res.booking_status}.`);
      const earliest = await earliestCheckIn(t, res.res_id);
      if (earliest && !beforeCutoff(nowLocal, earliest))
        throw new AppError("conflict", `Edits close 48 hours before the earliest check-in (cutoff ${cutoffFor(earliest)}).`);

      const old = (
        await t.query<OldRow>(
          "SELECT res_room_id, room_no, check_in_date::text, check_out_date::text FROM bookinn.reservation_room WHERE res_id = $1 ORDER BY res_room_id",
          [res.res_id],
        )
      ).rows;
      const byId = new Map(old.map((r) => [r.res_room_id, r]));

      for (const s of stays) {
        if (s.check_out_date <= s.check_in_date)
          throw new AppError("validation", `Room ${s.room_no}: check-out must be after check-in.`);
        if (s.res_room_id != null && !byId.has(Number(s.res_room_id)))
          throw new AppError("validation", `Reserved room #${s.res_room_id} is not part of reservation #${res.res_id}.`);
      }
      const ids = stays.filter((s) => s.res_room_id != null).map((s) => Number(s.res_room_id));
      if (new Set(ids).size !== ids.length) throw new AppError("validation", "A reserved room appears twice in the edit.");
      for (let i = 0; i < stays.length; i++)
        for (let j = i + 1; j < stays.length; j++) {
          const a = stays[i], b = stays[j];
          if (a.room_no === b.room_no && a.check_in_date < b.check_out_date && b.check_in_date < a.check_out_date)
            throw new AppError("validation", `Room ${a.room_no} is selected twice for overlapping dates.`);
        }

      const isChanged = (s: (typeof stays)[number], o: OldRow) =>
        String(o.room_no) !== s.room_no || o.check_in_date !== s.check_in_date || o.check_out_date !== s.check_out_date;
      const changed = stays.filter((s) => s.res_room_id != null && isChanged(s, byId.get(Number(s.res_room_id))!));
      const added = stays.filter((s) => s.res_room_id == null);
      const removed = old.filter((o) => !ids.includes(o.res_room_id));
      if (!changed.length && !added.length && !removed.length) throw new AppError("validation", "Nothing was changed.");

      // New or moved dates follow the booking rules: not in the past, and still before the 48-hour cutoff.
      const newEarliest = stays.map((s) => s.check_in_date).sort()[0];
      for (const s of [...changed, ...added]) {
        const o = s.res_room_id != null ? byId.get(Number(s.res_room_id)) : undefined;
        if (o && o.check_in_date === s.check_in_date) continue;
        if (s.check_in_date < today)
          throw new AppError("validation", `Room ${s.room_no}: bookings cannot start in the past (today is ${today}).`);
      }
      if (!beforeCutoff(nowLocal, newEarliest))
        throw new AppError("conflict", `The new earliest check-in ${newEarliest} is inside the 48-hour cutoff (${cutoffFor(newEarliest)}).`);

      // Same overlap check as a new booking; the reservation's own rooms are left out.
      for (const s of [...changed, ...added])
        await assertRoomAvailable(t, s.room_no, s.check_in_date, s.check_out_date, { resId: res.res_id, excludeResRoomId: s.res_room_id ?? null });

      let oldTotal = 0;
      let newTotal = 0;
      for (const s of changed) oldTotal += await rowCost(t, byId.get(Number(s.res_room_id))!);
      for (const o of removed) oldTotal += await rowCost(t, o);
      for (const s of [...changed, ...added]) newTotal += await rowCost(t, s);

      // Removals first, then changes, then additions, so rows of this reservation never overlap in between.
      for (const o of removed) await t.query("DELETE FROM bookinn.reservation_room WHERE res_room_id = $1", [o.res_room_id]);
      for (const s of changed)
        await t.query("UPDATE bookinn.reservation_room SET room_no = $2, check_in_date = $3, check_out_date = $4 WHERE res_room_id = $1", [
          s.res_room_id, s.room_no, s.check_in_date, s.check_out_date,
        ]);
      const addedIds: number[] = [];
      for (const s of added) {
        const r = await t.query<{ res_room_id: number }>(
          "INSERT INTO bookinn.reservation_room (res_id, room_no, check_in_date, check_out_date) VALUES ($1, $2, $3, $4) RETURNING res_room_id",
          [res.res_id, s.room_no, s.check_in_date, s.check_out_date],
        );
        addedIds.push(r.rows[0].res_room_id);
      }

      const diff = newTotal - oldTotal;
      let chargeId: number | null = null;
      if (diff !== 0) {
        const c = await t.query<{ charge_id: number }>(
          "INSERT INTO bookinn.adjustment_charge (res_id, charge_type, charge_amt) VALUES ($1, 'Modification', $2) RETURNING charge_id",
          [res.res_id, diff / 100],
        );
        chargeId = c.rows[0].charge_id;
      }
      return {
        resId: Number(res.res_id),
        changed: changed.map((s) => Number(s.res_room_id)),
        added: addedIds,
        removed: removed.map((o) => o.res_room_id),
        differenceCents: diff,
        chargeId,
      };
    });
  } catch (err) {
    mapDbError(err);
  }
}

export const describeDifference = (cents: number) =>
  cents === 0 ? "No price change." : cents > 0 ? `${peso(cents)} added to the check-out bill.` : `${peso(-cents)} taken off the check-out bill.`;
