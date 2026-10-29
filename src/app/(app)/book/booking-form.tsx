"use client";
import Link from "next/link";
import { useActionState } from "react";
import { bookingAction, type BookingState } from "@/app/actions";
import { peso } from "@/lib/money";

export interface Option {
  value: string;
  label: string;
}

function FieldError({ state, k }: { state: BookingState; k: string }) {
  const msg = state.fieldErrors?.[k];
  return msg ? <small id={`${k}_err`} className="field-error">{msg}</small> : null;
}

/**
 * Two-step booking form (SRS §1.4 "reviewed and edited prior to final
 * confirmation"): Review prices the stay on the server; Confirm saves the
 * reservation together with its one full payment and receipt.
 */
export function BookingForm({
  customers,
  rooms,
  defaults,
  today,
}: {
  customers: Option[];
  rooms: Option[];
  defaults: { cus_id?: string; check_in_date?: string; check_out_date?: string; room_no?: string[] };
  today: string;
}) {
  const [state, action, pending] = useActionState<BookingState, FormData>(bookingAction, {});
  const v: Record<string, string | undefined> = { cus_id: defaults.cus_id, check_in_date: defaults.check_in_date, check_out_date: defaults.check_out_date, ...state.values };
  const selected = new Set(state.rooms ?? defaults.room_no ?? []);
  const q = state.quote;
  const err = (k: string) => state.fieldErrors?.[k];
  const errId = (k: string) => (err(k) ? `${k}_err` : undefined);

  return (
    <form action={action} className="grid gap-6" noValidate>
      {state.error && (
        <p role="alert" className="rounded-md border border-[#f5c2bd] bg-danger-soft px-4 py-3 text-sm text-danger">{state.error}</p>
      )}

      {!q ? (
        <section className="card grid gap-5" aria-labelledby="stay-h">
          <h2 id="stay-h">1. Guest and stay</h2>
          <div className="grid gap-1">
            <label htmlFor="cus_id">Customer <span aria-hidden="true" className="text-danger">*</span></label>
            <select id="cus_id" name="cus_id" defaultValue={v.cus_id ?? ""} required aria-invalid={!!err("cus_id") || undefined} aria-describedby={errId("cus_id")} key={`c${v.cus_id}`}>
              <option value="">— Select a guest —</option>
              {customers.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            <small className="help">Guest not listed? <Link href="/customer/new">Add the customer first</Link> (name, email and mobile are required).</small>
            <FieldError state={state} k="cus_id" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1">
              <label htmlFor="check_in_date">Check-in <span aria-hidden="true" className="text-danger">*</span></label>
              <input id="check_in_date" name="check_in_date" type="date" min={today} defaultValue={v.check_in_date} key={`i${v.check_in_date}`} required aria-invalid={!!err("check_in_date") || undefined} aria-describedby={errId("check_in_date")} />
              <FieldError state={state} k="check_in_date" />
            </div>
            <div className="grid gap-1">
              <label htmlFor="check_out_date">Check-out <span aria-hidden="true" className="text-danger">*</span></label>
              <input id="check_out_date" name="check_out_date" type="date" min={today} defaultValue={v.check_out_date} key={`o${v.check_out_date}`} required aria-invalid={!!err("check_out_date") || undefined} aria-describedby={errId("check_out_date")} />
              <FieldError state={state} k="check_out_date" />
            </div>
          </div>
          <fieldset className="grid gap-2" aria-describedby={errId("room_no") ?? errId("stays")}>
            <legend className="mb-1 text-sm font-medium">Rooms <span aria-hidden="true" className="text-danger">*</span></legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {rooms.map((r) => (
                <label key={r.value} className="flex cursor-pointer items-center gap-2 rounded-md border border-line bg-white px-3 py-2 font-normal has-[:checked]:border-brand-600 has-[:checked]:bg-brand-100">
                  <input type="checkbox" name="room_no" value={r.value} defaultChecked={selected.has(r.value)} />
                  <span>{r.label}</span>
                </label>
              ))}
            </div>
            <small className="help">All selected rooms use the dates above. Availability is checked when you review.</small>
            <FieldError state={state} k="room_no" />
            <FieldError state={state} k="stays" />
          </fieldset>
          <div className="grid gap-1 sm:max-w-xs">
            <label htmlFor="discount_type">Loyalty discount</label>
            <select id="discount_type" name="discount_type" defaultValue={v.discount_type ?? "NONE"} key={`d${v.discount_type}`} aria-invalid={!!err("discount_type") || undefined} aria-describedby={errId("discount_type")}>
              <option value="NONE">None (earn points)</option>
              <option value="12% Discount">12% Discount (100 points)</option>
              <option value="Free Night">Free Night (250 points)</option>
            </select>
            <small className="help">A payment either earns points (amount ÷ 50) or spends them, never both.</small>
            <FieldError state={state} k="discount_type" />
          </div>
          <div>
            <button type="submit" name="$intent" value="review" className="btn btn-primary" disabled={pending}>
              {pending ? "Checking…" : "Review booking"}
            </button>
          </div>
        </section>
      ) : (
        <>
          {/* Carry the reviewed choices to the confirm step. */}
          <input type="hidden" name="cus_id" value={v.cus_id ?? ""} />
          <input type="hidden" name="check_in_date" value={v.check_in_date ?? ""} />
          <input type="hidden" name="check_out_date" value={v.check_out_date ?? ""} />
          <input type="hidden" name="discount_type" value={q.discount} />
          {[...selected].map((r) => <input key={r} type="hidden" name="room_no" value={r} />)}

          <section className="card" aria-labelledby="sum-h">
            <h2 id="sum-h" className="mb-3">2. Booking summary</h2>
            <p className="mb-3 text-sm">
              <strong>{q.customer.cus_name}</strong> · {q.customer.cus_email}
              {q.loyalty ? ` · Loyalty #${q.loyalty.lyl_id} (${q.loyalty.total_pts} pts)` : " · No loyalty account"}
            </p>
            <div className="overflow-x-auto rounded-lg border border-line">
              <table>
                <thead><tr><th scope="col">Room</th><th scope="col">Dates</th><th scope="col">Nights</th><th scope="col">Price / night</th><th scope="col" className="text-right">Subtotal</th></tr></thead>
                <tbody>
                  {q.lines.map((l) => (
                    <tr key={l.room_no}>
                      <td>{l.room_no} – {l.room_type}, {l.room_view}</td>
                      <td>{l.check_in_date} → {l.check_out_date}</td>
                      <td>{l.nights}</td>
                      <td>{peso(l.nightlyCents)}</td>
                      <td className="text-right">{peso(l.subtotalCents)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="text-sm">
                  <tr><td colSpan={4} className="text-right">Base total</td><td className="text-right">{peso(q.totalCents)}</td></tr>
                  {q.discountCents > 0 && (
                    <tr><td colSpan={4} className="text-right">{q.discount} (−{q.pointsSpend} pts)</td><td className="text-right">−{peso(q.discountCents)}</td></tr>
                  )}
                  <tr className="font-semibold text-brand-900"><td colSpan={4} className="text-right">Amount due</td><td className="text-right">{peso(q.dueCents)}</td></tr>
                </tfoot>
              </table>
            </div>
            <p className="mt-3 text-sm text-muted">
              {q.pointsEarn > 0 && `The guest will earn ${q.pointsEarn} loyalty points. `}
              {q.pointsSpend > 0 && `${q.pointsSpend} points will be deducted. `}
              {!q.loyalty && "No points are earned without a loyalty account. "}
              Points are final once the payment is logged, even if the reservation is later cancelled.
            </p>
          </section>

          <section className="card grid gap-5" aria-labelledby="pay-h">
            <h2 id="pay-h">3. Record the full payment</h2>
            <p className="text-sm text-muted">
              Collect the full amount from the guest, then record it here. BookInn keeps the record only; it does not charge cards or move money.
              After confirming, the room selection and dates can no longer be edited.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1">
                <label htmlFor="pay_method">Payment method <span aria-hidden="true" className="text-danger">*</span></label>
                <select id="pay_method" name="pay_method" defaultValue={v.pay_method ?? ""} key={`m${v.pay_method}`} required aria-invalid={!!err("pay_method") || undefined} aria-describedby={errId("pay_method")}>
                  <option value="">— Select —</option>
                  {["Cash", "Bank", "Card", "Digital Wallet"].map((m) => <option key={m}>{m}</option>)}
                </select>
                <FieldError state={state} k="pay_method" />
              </div>
              <div className="grid gap-1">
                <label htmlFor="pay_amt">Amount received (₱) <span aria-hidden="true" className="text-danger">*</span></label>
                <input id="pay_amt" name="pay_amt" inputMode="decimal" placeholder={(q.dueCents / 100).toFixed(2)} defaultValue={v.pay_amt} key={`a${v.pay_amt}`} required aria-invalid={!!err("pay_amt") || undefined} aria-describedby={errId("pay_amt") ?? "pay_amt_help"} />
                <small id="pay_amt_help" className="help">Must equal the amount due: {peso(q.dueCents)}.</small>
                <FieldError state={state} k="pay_amt" />
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <button type="submit" name="$intent" value="confirm" className="btn btn-primary" disabled={pending}>
                {pending ? "Saving…" : `Confirm booking and record ${peso(q.dueCents)}`}
              </button>
              <button type="submit" name="$intent" value="edit" className="btn btn-secondary" disabled={pending} formNoValidate>
                Edit booking
              </button>
            </div>
          </section>
        </>
      )}
    </form>
  );
}
