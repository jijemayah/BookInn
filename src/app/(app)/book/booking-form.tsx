"use client";
import Link from "next/link";
import { useActionState, useState } from "react";
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

type Stay = { in: string; out: string };

/**
 * Two-step booking form: Review prices the stay on the server; Confirm saves
 * the reservation together with its one full payment and receipt. Every room
 * in the reservation has its own check-in and check-out dates.
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
  const v: Record<string, string | undefined> = { cus_id: defaults.cus_id, ...state.values };
  const q = state.quote;
  const err = (k: string) => state.fieldErrors?.[k];

  // Per-room dates live in client state so they survive Review → Edit and server errors.
  const [stays, setStays] = useState<Record<string, Stay>>(() =>
    Object.fromEntries(
      (defaults.room_no ?? []).map((r) => [r, { in: defaults.check_in_date ?? "", out: defaults.check_out_date ?? "" }]),
    ),
  );
  const picked = Object.keys(stays).sort((a, b) => Number(a) - Number(b));

  const toggle = (room: string, on: boolean) =>
    setStays((cur) => {
      const next = { ...cur };
      if (!on) {
        delete next[room];
        return next;
      }
      // A newly ticked room starts with the dates of the first ticked room (or the dashboard's range).
      const first = Object.values(cur)[0];
      next[room] = first ? { ...first } : { in: defaults.check_in_date ?? "", out: defaults.check_out_date ?? "" };
      return next;
    });
  const setDate = (room: string, part: keyof Stay, value: string) =>
    setStays((cur) => ({ ...cur, [room]: { ...cur[room], [part]: value } }));

  return (
    <form action={action} className="grid gap-6" noValidate>
      {state.error && (
        <p role="alert" className="rounded-md border border-[#f5c2bd] bg-danger-soft px-4 py-3 text-sm text-danger">{state.error}</p>
      )}

      {!q ? (
        <section className="card grid gap-5" aria-labelledby="stay-h">
          <h2 id="stay-h">1. Guest and rooms</h2>
          <div className="grid gap-1">
            <label htmlFor="cus_id">Customer <span aria-hidden="true" className="text-danger">*</span></label>
            <select id="cus_id" name="cus_id" defaultValue={v.cus_id ?? ""} required aria-invalid={!!err("cus_id") || undefined} aria-describedby={err("cus_id") ? "cus_id_err" : undefined} key={`c${v.cus_id}`}>
              <option value="">— Select a guest —</option>
              {customers.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            <small className="help">Guest not listed? <Link href="/customer/new">Add a customer</Link>.</small>
            <FieldError state={state} k="cus_id" />
          </div>

          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Rooms and dates <span aria-hidden="true" className="text-danger">*</span></legend>
            <small className="help">Tick a room, then set its own check-in and check-out. Rooms in one reservation can have different dates.</small>
            <div className="grid gap-2">
              {rooms.map((r) => {
                const on = r.value in stays;
                return (
                  <div key={r.value} className={`rounded-md border px-3 py-2 ${on ? "border-brand-600 bg-brand-100" : "border-line bg-white"}`}>
                    <label className="flex cursor-pointer items-center gap-2 font-normal">
                      <input type="checkbox" name="room_no" value={r.value} checked={on} onChange={(e) => toggle(r.value, e.target.checked)} />
                      <span>{r.label}</span>
                    </label>
                    {on && (
                      <div className="mt-2 grid gap-3 sm:grid-cols-2">
                        <div className="grid gap-1">
                          <label htmlFor={`in_${r.value}`} className="text-xs">Check-in</label>
                          <input id={`in_${r.value}`} name={`in_${r.value}`} type="date" min={today} value={stays[r.value].in} onChange={(e) => setDate(r.value, "in", e.target.value)} required aria-invalid={!!err(`in_${r.value}`) || undefined} aria-describedby={err(`in_${r.value}`) ? `in_${r.value}_err` : undefined} />
                          <FieldError state={state} k={`in_${r.value}`} />
                        </div>
                        <div className="grid gap-1">
                          <label htmlFor={`out_${r.value}`} className="text-xs">Check-out</label>
                          <input id={`out_${r.value}`} name={`out_${r.value}`} type="date" min={stays[r.value].in || today} value={stays[r.value].out} onChange={(e) => setDate(r.value, "out", e.target.value)} required aria-invalid={!!err(`out_${r.value}`) || undefined} aria-describedby={err(`out_${r.value}`) ? `out_${r.value}_err` : undefined} />
                          <FieldError state={state} k={`out_${r.value}`} />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <FieldError state={state} k="room_no" />
            <FieldError state={state} k="stays" />
          </fieldset>

          <div className="grid gap-1 sm:max-w-xs">
            <label htmlFor="discount_type">Loyalty discount</label>
            <select id="discount_type" name="discount_type" defaultValue={v.discount_type ?? "NONE"} key={`d${v.discount_type}`} aria-invalid={!!err("discount_type") || undefined} aria-describedby={err("discount_type") ? "discount_type_err" : undefined}>
              <option value="NONE">None (earn points)</option>
              <option value="12% Discount">12% Discount (100 points)</option>
              <option value="Free Night">Free Night (250 points)</option>
            </select>
            <small className="help">Discounts cannot be combined with earning points.</small>
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
          <input type="hidden" name="discount_type" value={q.discount} />
          {picked.map((r) => (
            <span key={r}>
              <input type="hidden" name="room_no" value={r} />
              <input type="hidden" name={`in_${r}`} value={stays[r].in} />
              <input type="hidden" name={`out_${r}`} value={stays[r].out} />
            </span>
          ))}

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
              {q.pointsEarn > 0 && `Earns ${q.pointsEarn} points.`}
              {q.pointsSpend > 0 && `Uses ${q.pointsSpend} points.`}
              {!q.loyalty && "No loyalty account."}
            </p>
          </section>

          <section className="card grid gap-5" aria-labelledby="pay-h">
            <h2 id="pay-h">3. Record the full payment</h2>
            <p className="text-sm text-muted">Reservations are locked once confirmed.</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1">
                <label htmlFor="pay_method">Payment method <span aria-hidden="true" className="text-danger">*</span></label>
                <select id="pay_method" name="pay_method" defaultValue={v.pay_method ?? ""} key={`m${v.pay_method}`} required aria-invalid={!!err("pay_method") || undefined} aria-describedby={err("pay_method") ? "pay_method_err" : undefined}>
                  <option value="">— Select —</option>
                  {["Cash", "Bank", "Card", "Digital Wallet"].map((m) => <option key={m}>{m}</option>)}
                </select>
                <FieldError state={state} k="pay_method" />
              </div>
              <div className="grid gap-1">
                <label htmlFor="pay_amt">Amount received (₱) <span aria-hidden="true" className="text-danger">*</span></label>
                <input id="pay_amt" name="pay_amt" inputMode="decimal" placeholder={(q.dueCents / 100).toFixed(2)} defaultValue={v.pay_amt} key={`a${v.pay_amt}`} required aria-invalid={!!err("pay_amt") || undefined} aria-describedby={err("pay_amt") ? "pay_amt_err" : "pay_amt_help"} />
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
