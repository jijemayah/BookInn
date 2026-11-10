"use client";
import Link from "next/link";
import { useActionState, useEffect, useMemo, useState, useTransition } from "react";
import { bookingAction, roomAvailabilityAction, type BookingState } from "@/app/actions";
import { peso, toCents } from "@/lib/money";
import { Icon } from "@/components/icons";
import { GuestPicker } from "@/components/guest-picker";

export interface Option {
  value: string;
  label: string;
}
export interface RoomOption {
  room_no: string;
  room_type: string;
  room_view: string;
  room_price: string;
}

function FieldError({ state, k }: { state: BookingState; k: string }) {
  const msg = state.fieldErrors?.[k];
  return msg ? <small id={`${k}_err`} className="field-error">{msg}</small> : null;
}

/** A selected room. `own` dates replace the shared stay dates when set (rooms may have different dates). */
type Pick = { own?: { in: string; out: string } };
const METHODS = ["Cash", "Card", "Bank", "Digital Wallet"] as const;

/**
 * Two-step booking form. Step 1: guest, stay dates and rooms (picked from tiles that show
 * whether each room is free for those dates). Step 2: the server prices the stay; the
 * Initial payment is the full amount due, filled in automatically (SRS: the initial booking
 * is paid upfront and the payment must equal the amount due). The server re-checks
 * everything on Confirm.
 */
export function BookingForm({
  customers,
  rooms,
  defaults,
  today,
}: {
  customers: Option[];
  rooms: RoomOption[];
  defaults: { cus_id?: string; check_in_date?: string; check_out_date?: string; room_no?: string[] };
  today: string;
}) {
  const [state, action, pending] = useActionState<BookingState, FormData>(bookingAction, {});
  const v: Record<string, string | undefined> = { cus_id: defaults.cus_id, ...state.values };
  const q = state.quote;
  const err = (k: string) => state.fieldErrors?.[k];

  // Client state survives Review → Edit and server errors.
  const [cusId, setCusId] = useState(defaults.cus_id ?? "");
  const [checkIn, setCheckIn] = useState(defaults.check_in_date ?? "");
  const [checkOut, setCheckOut] = useState(defaults.check_out_date ?? "");
  const [picks, setPicks] = useState<Record<string, Pick>>(() => Object.fromEntries((defaults.room_no ?? []).map((r) => [r, {}])));
  const [typeFilter, setTypeFilter] = useState("All");
  const [viewFilter, setViewFilter] = useState("All");
  const [method, setMethod] = useState(v.pay_method ?? "");
  const [discount, setDiscount] = useState(v.discount_type ?? "NONE");

  // Availability for the shared dates; a result only counts for the dates it was fetched for.
  const [avail, setAvail] = useState<{ key: string; taken: Set<number>; error?: string } | null>(null);
  const [checking, startCheck] = useTransition();
  const datesOk = !!checkIn && !!checkOut && checkOut > checkIn;
  const datesKey = `${checkIn}|${checkOut}`;
  useEffect(() => {
    if (!datesOk) return;
    let live = true;
    startCheck(async () => {
      const r = await roomAvailabilityAction(checkIn, checkOut);
      if (live) setAvail({ key: `${checkIn}|${checkOut}`, taken: new Set(r.taken), error: r.error });
    });
    return () => {
      live = false;
    };
  }, [checkIn, checkOut, datesOk]);
  const taken = datesOk && avail?.key === datesKey ? avail.taken : null;
  const availError = datesOk && avail?.key === datesKey ? avail.error : undefined;

  const types = useMemo(() => ["All", ...new Set(rooms.map((r) => r.room_type))], [rooms]);
  const views = useMemo(() => ["All", ...new Set(rooms.map((r) => r.room_view))], [rooms]);
  const shown = rooms.filter((r) => (typeFilter === "All" || r.room_type === typeFilter) && (viewFilter === "All" || r.room_view === viewFilter));

  const picked = Object.keys(picks).sort((a, b) => Number(a) - Number(b));
  const roomOf = (no: string) => rooms.find((r) => r.room_no === no);
  const datesOf = (no: string) => picks[no]?.own ?? { in: checkIn, out: checkOut };
  const nights = (d: { in: string; out: string }) =>
    d.in && d.out && d.out > d.in ? Math.round((Date.parse(d.out) - Date.parse(d.in)) / 86_400_000) : 0;
  const estimate = picked.reduce((a, no) => a + nights(datesOf(no)) * toCents(roomOf(no)?.room_price ?? "0"), 0);

  const toggle = (no: string) =>
    setPicks((cur) => {
      const next = { ...cur };
      if (no in next) delete next[no];
      else next[no] = {};
      return next;
    });
  const setOwn = (no: string, own?: { in: string; out: string }) => setPicks((cur) => ({ ...cur, [no]: { own } }));

  return (
    <form action={action} className="grid gap-6" noValidate>
      {state.error && (
        <p role="alert" className="animate-in rounded-md border border-[#f5c2bd] bg-danger-soft px-4 py-3 text-sm text-danger">{state.error}</p>
      )}

      {/* The selected rooms with their dates, in the shape the server expects. */}
      {picked.map((no) => (
        <span key={no}>
          <input type="hidden" name="room_no" value={no} />
          <input type="hidden" name={`in_${no}`} value={datesOf(no).in} />
          <input type="hidden" name={`out_${no}`} value={datesOf(no).out} />
        </span>
      ))}

      {!q ? (
        <>
          <section className="card animate-in grid gap-4" aria-labelledby="guest-h">
            <h2 id="guest-h" className="flex items-center gap-2"><Icon name="guest" /> 1. Guest</h2>
            <div className="grid gap-1 sm:max-w-xl">
              <label htmlFor="guest">Guest <span aria-hidden="true" className="text-danger">*</span></label>
              <GuestPicker
                name="cus_id"
                options={customers}
                value={cusId}
                onChange={setCusId}
                invalid={!!err("cus_id")}
                describedBy={err("cus_id") ? "cus_id_err" : "guest_help"}
              />
              <FieldError state={state} k="cus_id" />
              <small id="guest_help" className="help">
                Type part of the guest&rsquo;s name or email, then pick them from the list. Not listed? <Link href="/customer/new">Add a customer</Link>.
              </small>
            </div>
          </section>

          <section className="card animate-in grid gap-4" aria-labelledby="stay-h" style={{ animationDelay: "60ms" }}>
            <h2 id="stay-h" className="flex items-center gap-2"><Icon name="calendar" /> 2. Dates and rooms</h2>
            <div className="grid gap-3 sm:grid-cols-2 sm:max-w-md">
              <div className="grid gap-1">
                <label htmlFor="check_in_date">Check-in <span aria-hidden="true" className="text-danger">*</span></label>
                <input id="check_in_date" type="date" min={today} value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
              </div>
              <div className="grid gap-1">
                <label htmlFor="check_out_date">Check-out <span aria-hidden="true" className="text-danger">*</span></label>
                <input id="check_out_date" type="date" min={checkIn || today} value={checkOut} onChange={(e) => setCheckOut(e.target.value)} />
              </div>
            </div>
            <p className="help -mt-2">
              Check-in 14:00, check-out 12:00.{" "}
              {datesOk ? `${nights({ in: checkIn, out: checkOut })} night(s).` : "Pick the dates to see which rooms are free."}
            </p>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2" role="group" aria-label="Filter rooms">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-medium text-muted">Type</span>
                {types.map((t) => (
                  <button key={t} type="button" className={`chip ${typeFilter === t ? "chip-on" : ""}`} aria-pressed={typeFilter === t} onClick={() => setTypeFilter(t)}>{t}</button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-medium text-muted">View</span>
                {views.map((t) => (
                  <button key={t} type="button" className={`chip ${viewFilter === t ? "chip-on" : ""}`} aria-pressed={viewFilter === t} onClick={() => setViewFilter(t)}>{t}</button>
                ))}
              </div>
              <span className="ml-auto text-xs text-muted" aria-live="polite">
                {checking ? "Checking availability…" : datesOk && taken ? `${rooms.filter((r) => !taken.has(Number(r.room_no))).length} of ${rooms.length} rooms free` : ""}
              </span>
            </div>
            {availError && <p className="field-error">{availError}</p>}

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {shown.map((r, i) => {
                const on = r.room_no in picks;
                const isTaken = datesOk && !!taken?.has(Number(r.room_no)) && !picks[r.room_no]?.own;
                return (
                  <button
                    key={r.room_no}
                    type="button"
                    onClick={() => toggle(r.room_no)}
                    disabled={isTaken && !on}
                    aria-pressed={on}
                    aria-label={`Room ${r.room_no}, ${r.room_type}, ${r.room_view}, ${peso(toCents(r.room_price))} per night${isTaken ? ", not available for these dates" : ""}`}
                    className={`room-tile animate-in ${on ? "room-tile-on" : ""} ${isTaken ? "room-tile-taken" : ""}`}
                    style={{ animationDelay: `${Math.min(i, 20) * 15}ms` }}
                  >
                    <span className="flex items-start justify-between gap-2">
                      <span className="text-lg font-semibold leading-none text-brand-900">{r.room_no}</span>
                      <span className={`room-check ${on ? "room-check-on" : ""}`} aria-hidden="true"><Icon name="check" size={12} /></span>
                    </span>
                    <span className="mt-1 block text-xs text-muted">{r.room_type} · {r.room_view}</span>
                    <span className="mt-1 block text-sm font-medium text-ink">{peso(toCents(r.room_price))}<span className="text-xs font-normal text-muted"> /night</span></span>
                    {isTaken && <span className="mt-1 block text-xs font-medium text-danger">Taken</span>}
                  </button>
                );
              })}
              {shown.length === 0 && <p className="col-span-full text-sm text-muted">No rooms match these filters.</p>}
            </div>
            <FieldError state={state} k="room_no" />
            <FieldError state={state} k="stays" />

            {picked.length > 0 && (
              <div className="animate-in rounded-lg border border-brand-200 bg-brand-100/60 p-3">
                <p className="mb-2 text-sm font-medium text-brand-900">Selected: {picked.length} room{picked.length === 1 ? "" : "s"}</p>
                <ul className="grid gap-2">
                  {picked.map((no) => {
                    const own = picks[no].own;
                    const d = datesOf(no);
                    const r = roomOf(no);
                    return (
                      <li key={no} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md bg-white px-3 py-2 text-sm">
                        <span className="font-medium">Room {no}</span>
                        <span className="text-muted">{r?.room_type}, {r?.room_view}</span>
                        {own ? (
                          <span className="flex flex-wrap items-center gap-2">
                            <input aria-label={`Room ${no} check-in`} type="date" min={today} value={own.in} onChange={(e) => setOwn(no, { ...own, in: e.target.value })} className="w-auto py-1" />
                            <span aria-hidden="true">→</span>
                            <input aria-label={`Room ${no} check-out`} type="date" min={own.in || today} value={own.out} onChange={(e) => setOwn(no, { ...own, out: e.target.value })} className="w-auto py-1" />
                            <button type="button" className="btn-link" onClick={() => setOwn(no, undefined)}>Use the stay dates</button>
                          </span>
                        ) : (
                          <span className="flex flex-wrap items-center gap-2">
                            <span>{d.in && d.out ? `${d.in} → ${d.out}` : "Set the stay dates above"}</span>
                            <button type="button" className="btn-link" onClick={() => setOwn(no, { in: checkIn, out: checkOut })}>Different dates</button>
                          </span>
                        )}
                        <FieldError state={state} k={`in_${no}`} />
                        <FieldError state={state} k={`out_${no}`} />
                        <button type="button" className="btn-link ml-auto text-danger" onClick={() => toggle(no)} aria-label={`Remove room ${no}`}>Remove</button>
                      </li>
                    );
                  })}
                </ul>
                {estimate > 0 && <p className="mt-2 text-xs text-muted">Estimated {peso(estimate)} before any discount. The exact amount is computed on the next step.</p>}
              </div>
            )}
          </section>

          <section className="card animate-in grid gap-4" aria-labelledby="disc-h" style={{ animationDelay: "120ms" }}>
            <h2 id="disc-h" className="flex items-center gap-2"><Icon name="loyalty" /> 3. Loyalty discount</h2>
            <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Loyalty discount">
              {[
                ["NONE", "None", "Earn points on this payment"],
                ["12% Discount", "12% Discount", "Uses 100 points"],
                ["Free Night", "Free Night", "Uses 250 points · most expensive room"],
              ].map(([value, title, sub]) => (
                <label key={value} className="option-card">
                  <input type="radio" name="discount_type" value={value} checked={discount === value} onChange={() => setDiscount(value)} className="sr-only" />
                  <span className="block text-sm font-semibold text-brand-900">{title}</span>
                  <span className="block text-xs text-muted">{sub}</span>
                </label>
              ))}
            </div>
            <small className="help">One discount per booking. A discounted payment earns no points.</small>
            <FieldError state={state} k="discount_type" />
            <div>
              <button type="submit" name="$intent" value="review" className="btn btn-primary" disabled={pending || picked.length === 0}>
                {pending ? <><span className="spinner" aria-hidden="true" /> Checking…</> : <>Review booking <Icon name="arrow" size={16} /></>}
              </button>
              {picked.length === 0 && <span className="help ml-3">Select at least one room.</span>}
            </div>
          </section>
        </>
      ) : (
        <>
          <input type="hidden" name="cus_id" value={v.cus_id ?? cusId} />
          <input type="hidden" name="discount_type" value={q.discount} />
          {/* The Initial payment is the full amount due, computed by the server. */}
          <input type="hidden" name="pay_amt" value={(q.dueCents / 100).toFixed(2)} />

          <section className="card animate-in" aria-labelledby="sum-h">
            <h2 id="sum-h" className="mb-3 flex items-center gap-2"><Icon name="bookings" /> Booking summary</h2>
            <p className="mb-3 text-sm">
              <strong>{q.customer.cus_name}</strong> · {q.customer.cus_email}
              {q.loyalty ? ` · Loyalty #${q.loyalty.lyl_id} (${q.loyalty.total_pts} pts)` : " · No loyalty account"}
            </p>
            <div className="overflow-x-auto rounded-lg border border-line">
              <table>
                <thead><tr><th scope="col">Room</th><th scope="col">Dates</th><th scope="col">Nights</th><th scope="col">Price / night</th><th scope="col" className="text-right">Subtotal</th></tr></thead>
                <tbody>
                  {q.lines.map((l) => (
                    <tr key={`${l.room_no}-${l.check_in_date}`}>
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
                </tfoot>
              </table>
            </div>
          </section>

          <section className="card animate-in grid gap-5" aria-labelledby="pay-h" style={{ animationDelay: "60ms" }}>
            <h2 id="pay-h" className="flex items-center gap-2"><Icon name="payments" /> Initial payment (paid upfront)</h2>
            <div className="flex flex-wrap items-end justify-between gap-4 rounded-lg border border-brand-200 bg-brand-100 px-4 py-3">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-brand-800">Amount due now</p>
                <p className="text-3xl font-semibold text-brand-900">{peso(q.dueCents)}</p>
              </div>
              <p className="text-sm text-muted">
                {q.pointsEarn > 0 && `Earns ${q.pointsEarn} points, credited when the stay is Completed. `}
                {q.pointsSpend > 0 && `Uses ${q.pointsSpend} points. `}
                {!q.loyalty && "No loyalty account."}
              </p>
            </div>
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">Payment method <span aria-hidden="true" className="text-danger">*</span></legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup">
                {METHODS.map((m) => (
                  <label key={m} className="option-card text-center">
                    <input type="radio" name="pay_method" value={m} checked={method === m} onChange={() => setMethod(m)} className="sr-only" />
                    <span className="block text-sm font-semibold text-brand-900">{m}</span>
                  </label>
                ))}
              </div>
              <FieldError state={state} k="pay_method" />
              <FieldError state={state} k="pay_amt" />
            </fieldset>
            <p className="text-sm text-muted">
              The full amount is recorded as the Initial payment and the receipt is emailed to the guest. Later edits (until 48 hours
              before check-in) and extensions are posted as charges and paid at check-out.
            </p>
            <div className="flex flex-wrap gap-3">
              <button type="submit" name="$intent" value="confirm" className="btn btn-primary" disabled={pending || !method}>
                {pending ? <><span className="spinner" aria-hidden="true" /> Saving…</> : <><Icon name="check" size={16} /> Confirm booking · {peso(q.dueCents)}</>}
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
