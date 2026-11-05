/**
 * Reservation page: the stay (rooms, check-in/out, extension), the bill
 * (Initial payment, Unpaid charges, check-out settlement), editing and
 * cancellation, following SRS v2 Table 2 (Front Desk and the Database
 * Administrator act; Finance reads). Every action is re-checked on the server.
 */
import type { ReservationView, StayRoom } from "@/lib/reservation-view";
import { peso } from "@/lib/money";
import { ENUMS } from "@/lib/entities";
import { addDays } from "@/lib/dates";
import { cancelReservationAction, checkInAction, checkOutAction, extendAction, modifyAction, settleAction } from "@/app/actions";
import { ActionForm } from "@/components/forms";
import { Section, StatusBadge } from "@/components/ui";

type RoomChoice = { room_no: number; room_type: string; room_view: string; room_price: string };

function RoomSelect({ name, rooms, value, allowEmpty, label }: { name: string; rooms: RoomChoice[]; value?: number; allowEmpty?: string; label: string }) {
  return (
    <select name={name} defaultValue={value ? String(value) : ""} aria-label={label} className="w-auto">
      {allowEmpty !== undefined && <option value="">{allowEmpty}</option>}
      {rooms.map((r) => (
        <option key={r.room_no} value={r.room_no}>
          Room {r.room_no} – {r.room_type}, {r.room_view} (₱{r.room_price}/night)
        </option>
      ))}
    </select>
  );
}

function roomState(r: StayRoom) {
  if (r.actual_check_out) return `Checked out ${r.actual_check_out}`;
  if (r.actual_check_in) return `Checked in ${r.actual_check_in}`;
  return "Not checked in";
}

export function ReservationPanel({ v, rooms }: { v: ReservationView; rooms: RoomChoice[] }) {
  const id = String(v.resId);
  return (
    <>
      <Section title="Stay">
        <dl className="details mb-4">
          <dt>Status</dt>
          <dd><StatusBadge value={v.status} /></dd>
          <dt>Guest</dt>
          <dd>{v.guest.cus_name} · {v.guest.cus_email}</dd>
          {v.earliestCheckIn && (
            <>
              <dt>Earliest check-in</dt>
              <dd>
                {v.earliestCheckIn} at 14:00
                {v.status === "Booked" && (
                  <span className="help"> · edit and full-refund cutoff {v.cutoff} ({v.beforeCutoff ? "not yet reached" : "passed"})</span>
                )}
              </dd>
            </>
          )}
          <dt>Paid upfront</dt>
          <dd>{peso(v.paidCents)}{v.pointsSpent > 0 && <span className="help"> · {v.pointsSpent} loyalty points spent</span>}</dd>
          <dt>Due at check-out</dt>
          <dd>
            {v.unpaidCount === 0 ? "Nothing" : `${peso(v.unpaidCents)} (${v.unpaidCount} Unpaid charge${v.unpaidCount === 1 ? "" : "s"})`}
            {v.settled && <span className="help"> · settled at check-out</span>}
          </dd>
        </dl>

        <div className="overflow-x-auto rounded-lg border border-line">
          <table>
            <thead>
              <tr>
                <th scope="col">Room</th>
                <th scope="col">Dates</th>
                <th scope="col">Check-in / out</th>
                {v.canAct && <th scope="col">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {v.rooms.map((r) => (
                <tr key={r.res_room_id}>
                  <td>
                    Room {r.room_no}
                    <div className="text-xs text-muted">{r.room_type}, {r.room_view} · ₱{r.room_price}/night</div>
                  </td>
                  <td>{r.check_in_date} → {r.check_out_date}</td>
                  <td className="text-sm">{roomState(r)}</td>
                  {v.canAct && (
                    <td>
                      <div className="grid gap-2">
                        {r.canCheckIn && (
                          <ActionForm action={checkInAction.bind(null, id, String(r.res_room_id))} submitLabel="Check in" pendingLabel="Checking in…" />
                        )}
                        {r.canCheckOut && (
                          <ActionForm
                            action={checkOutAction.bind(null, id, String(r.res_room_id))}
                            submitLabel="Check out"
                            pendingLabel="Checking out…"
                            variant="secondary"
                            confirmText={`Check out room ${r.room_no}? Leaving before ${r.check_out_date} is an early departure: no refund for prepaid nights, unused extension nights are voided.`}
                          />
                        )}
                        {r.canExtend && (
                          <details>
                            <summary className="cursor-pointer text-sm">Extend stay…</summary>
                            <div className="mt-2">
                              <ActionForm action={extendAction.bind(null, id, String(r.res_room_id))} submitLabel="Extend" pendingLabel="Extending…" variant="secondary">
                                <div className="grid gap-1">
                                  <label htmlFor={`ext_${r.res_room_id}`}>New check-out</label>
                                  <input id={`ext_${r.res_room_id}`} name="new_check_out" type="date" min={addDays(r.check_out_date, 1)} defaultValue={addDays(r.check_out_date, 1)} required className="w-auto" />
                                </div>
                                <div className="grid gap-1">
                                  <span className="text-sm">Room</span>
                                  <RoomSelect name="room_no" rooms={rooms} allowEmpty={`Same room (${r.room_no}) if free`} label="Room for the extra nights" />
                                </div>
                              </ActionForm>
                              <p className="help mt-1">Extra nights are charged at the room rate and paid at check-out. If this room is taken, choose another room.</p>
                            </div>
                          </details>
                        )}
                        {!r.canCheckIn && !r.canCheckOut && !r.canExtend && <span className="text-xs text-muted">—</span>}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {v.status === "Booked" && v.canAct && v.rooms.some((r) => !r.canCheckIn) && (
          <p className="help mt-2">Rooms can be checked in on or after their check-in date, never before.</p>
        )}
      </Section>

      {v.canSettle && (
        <Section title="Settle the bill at check-out">
          <p className="mb-3 text-sm">
            Unpaid charges: <strong>{peso(v.unpaidCents)}</strong>.{" "}
            {v.unpaidCents > 0
              ? "The guest pays this amount in one Checkout payment (no discount)."
              : v.unpaidCents < 0
                ? "The charges add up to less than zero, so a Checkout Credit refund is recorded instead of a payment."
                : "The charges cancel each other out; nothing is paid or refunded."}
          </p>
          <ActionForm
            action={settleAction.bind(null, id)}
            submitLabel={v.unpaidCents > 0 ? "Record Checkout payment" : v.unpaidCents < 0 ? "Record Checkout Credit refund" : "Settle charges"}
            pendingLabel="Saving…"
          >
            {v.unpaidCents > 0 && (
              <>
                <div className="grid gap-1">
                  <label htmlFor="pay_method">Payment method</label>
                  <select id="pay_method" name="pay_method" required defaultValue="" className="w-auto">
                    <option value="">— Select —</option>
                    {ENUMS.pay_method.map((m) => <option key={m}>{m}</option>)}
                  </select>
                </div>
                <div className="grid gap-1">
                  <label htmlFor="pay_amt">Amount received (₱)</label>
                  <input id="pay_amt" name="pay_amt" inputMode="decimal" required placeholder={(v.unpaidCents / 100).toFixed(2)} className="w-40" />
                </div>
              </>
            )}
          </ActionForm>
          <p className="help mt-2">A receipt (or refund confirmation) is emailed to {v.guest.cus_email}.</p>
        </Section>
      )}

      {v.canModify && (
        <Section title="Edit reservation">
          <p className="mb-3 text-sm text-muted">
            Change rooms or dates, remove rooms, or add one. Changed rooms are re-priced at the room rate; the difference is posted as a
            Modification charge paid at check-out (no loyalty discount). The guest cannot be changed. Edits close at {v.cutoff}.
          </p>
          <ActionForm action={modifyAction.bind(null, id)} submitLabel="Save changes" pendingLabel="Saving…" className="grid gap-3">
            {v.rooms.map((r) => (
              <fieldset key={r.res_room_id} className="flex flex-wrap items-end gap-3 rounded-lg border border-line p-3">
                <legend className="px-1 text-sm font-medium">Reserved room #{r.res_room_id}</legend>
                <input type="hidden" name="row" value={r.res_room_id} />
                <div className="grid gap-1">
                  <span className="text-sm">Room</span>
                  <RoomSelect name={`room_${r.res_room_id}`} rooms={rooms} value={r.room_no} label={`Room for reserved room ${r.res_room_id}`} />
                </div>
                <div className="grid gap-1">
                  <label htmlFor={`in_${r.res_room_id}`}>Check-in</label>
                  <input id={`in_${r.res_room_id}`} name={`in_${r.res_room_id}`} type="date" defaultValue={r.check_in_date} className="w-auto" />
                </div>
                <div className="grid gap-1">
                  <label htmlFor={`out_${r.res_room_id}`}>Check-out</label>
                  <input id={`out_${r.res_room_id}`} name={`out_${r.res_room_id}`} type="date" defaultValue={r.check_out_date} className="w-auto" />
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name={`remove_${r.res_room_id}`} className="w-auto" /> Remove
                </label>
              </fieldset>
            ))}
            <fieldset className="flex flex-wrap items-end gap-3 rounded-lg border border-dashed border-brand-300 p-3">
              <legend className="px-1 text-sm font-medium">Add a room (optional)</legend>
              <div className="grid gap-1">
                <span className="text-sm">Room</span>
                <RoomSelect name="new_room" rooms={rooms} allowEmpty="— None —" label="Room to add" />
              </div>
              <div className="grid gap-1">
                <label htmlFor="new_in">Check-in</label>
                <input id="new_in" name="new_in" type="date" className="w-auto" />
              </div>
              <div className="grid gap-1">
                <label htmlFor="new_out">Check-out</label>
                <input id="new_out" name="new_out" type="date" className="w-auto" />
              </div>
            </fieldset>
          </ActionForm>
        </Section>
      )}

      {v.canCancel && (
        <Section title="Cancel reservation (guest request)">
          <p className="mb-4 text-sm text-muted">
            {v.beforeCutoff
              ? `It is at least 48 hours before the earliest check-in (cutoff ${v.cutoff}): the ${peso(v.paidCents)} paid is refunded in full.`
              : `The 48-hour cutoff (${v.cutoff}) has passed: no refund.`}{" "}
            Spent loyalty points are returned; earned points are never credited. Unpaid edit charges are voided.
          </p>
          <ActionForm
            action={cancelReservationAction.bind(null, id)}
            submitLabel={`Cancel reservation #${id}`}
            pendingLabel="Cancelling…"
            variant="danger"
            confirmText={`Cancel reservation #${id} at the guest's request? ${v.beforeCutoff ? "A full refund will be recorded." : "No refund will be given."} This cannot be undone by Front Desk.`}
          />
        </Section>
      )}
    </>
  );
}
