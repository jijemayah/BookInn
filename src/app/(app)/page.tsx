import Link from "next/link";
import { getDb } from "@/lib/db/pg";
import { requireStaff } from "@/lib/session";
import { dashboardStats, roomAvailability } from "@/lib/dashboard";
import { DBA, ENTITIES, can } from "@/lib/entities";
import { addDays, hotelToday } from "@/lib/dates";
import { isRealDate } from "@/lib/validation";
import { peso } from "@/lib/money";
import { runMaintenanceAction } from "@/app/actions";
import { ConfirmButton } from "@/components/forms";
import { EmptyState, PageHeader, Section, Stat, StatusBadge } from "@/components/ui";

export default async function Dashboard({ searchParams }: PageProps<"/">) {
  const staff = await requireStaff();
  const actor = { staffId: staff.staffId, role: staff.role };
  const sp = await searchParams;
  const db = getDb();
  const today = hotelToday();
  const s = await dashboardStats(db, actor, today);

  const from = typeof sp.from === "string" && isRealDate(sp.from) ? sp.from : today;
  const toRaw = typeof sp.to === "string" && isRealDate(sp.to) ? sp.to : addDays(from, 1);
  const to = toRaw > from ? toRaw : addDays(from, 1);
  const rooms = await roomAvailability(db, actor, from, to);
  const canBook = can(staff.role, ENTITIES.reservation, "create");

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={`Overview for ${today}.`}
        actions={canBook && <Link href="/book" className="btn btn-primary">New booking</Link>}
      />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Customers" value={s.customers} href="/customer" />
        <Stat label="Rooms available tonight" value={`${s.availableTonight} / ${s.rooms}`} href="/room" />
        <Stat label="In-house now" value={s.inHouse} hint="Booked stays covering today" />
        <Stat label="Upcoming stays" value={s.upcoming} hint="Booked, arriving after today" href="/reservation?booking_status=Booked" />
        <Stat label="Booked" value={s.booked} href="/reservation?booking_status=Booked" />
        <Stat label="Completed" value={s.completed} href="/reservation?booking_status=Completed" />
        <Stat label="Cancelled" value={s.cancelled} href="/reservation?booking_status=Cancelled" />
        <Stat label="Loyalty accounts" value={s.loyaltyAccounts} hint={`${s.loyaltyPoints.toLocaleString("en-PH")} points outstanding`} href="/loyalty_acc" />
        <Stat label="Payments recorded" value={s.payments} href="/payment" />
        <Stat label="Revenue recorded (all)" value={peso(s.revenueCents)} hint="Sum of payment records" />
        <Stat label="Revenue this month" value={peso(s.revenueThisMonthCents)} hint={`Payments dated ${today.slice(0, 7)}`} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Room availability">
          <form className="mb-4 flex flex-wrap items-end gap-3" role="search" aria-label="Check availability">
            <div className="grid gap-1">
              <label htmlFor="from">Check-in</label>
              <input id="from" name="from" type="date" defaultValue={from} className="w-auto" />
            </div>
            <div className="grid gap-1">
              <label htmlFor="to">Check-out</label>
              <input id="to" name="to" type="date" defaultValue={to} className="w-auto" />
            </div>
            <button type="submit" className="btn btn-secondary">Check</button>
          </form>
          <p className="mb-3 text-xs text-muted">{from} → {to}</p>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table>
              <thead>
                <tr><th scope="col">Room</th><th scope="col">Type</th><th scope="col">Price / night</th><th scope="col">Status</th></tr>
              </thead>
              <tbody>
                {rooms.map((r) => (
                  <tr key={r.room_no}>
                    <td>{r.room_no}</td>
                    <td>{r.room_type}, {r.room_view}</td>
                    <td>₱{r.room_price}</td>
                    <td>
                      {r.available ? (
                        <span className="badge bg-brand-200 text-brand-900">Available</span>
                      ) : (
                        <Link href={`/reservation/${r.blocked_by}`} className="badge bg-danger-soft text-danger">Booked (#{r.blocked_by})</Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {canBook && rooms.some((r) => r.available) && from >= today && (
            <Link href={`/book?check_in_date=${from}&check_out_date=${to}`} className="btn btn-primary mt-4">Book these dates</Link>
          )}
        </Section>

        <Section title="Current and upcoming stays" actions={<Link href="/reservation?booking_status=Booked" className="text-sm">All booked</Link>}>
          {s.nextArrivals.length === 0 ? (
            <EmptyState title="No booked stays" />
          ) : (
            <ul className="divide-y divide-line">
              {s.nextArrivals.map((a) => (
                <li key={`${a.res_id}-${a.room_no}`} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span>
                    <Link href={`/reservation/${a.res_id}`}>#{a.res_id}</Link> · {a.cus_name} · Room {a.room_no}
                  </span>
                  <span className="text-muted">
                    {a.check_in_date} → {a.check_out_date} {a.check_in_date <= today && <StatusBadge value="Booked" />}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {staff.role === DBA && (
        <Section title="Daily maintenance">
          <p className="mb-4 text-sm text-muted">
            Runs automatically every day. Completes finished stays and removes reservation records one year after check-out.
          </p>
          <ConfirmButton
            action={runMaintenanceAction}
            label="Run daily maintenance now"
            pendingLabel="Running…"
            variant="secondary"
            confirmText="Run maintenance now? Expired reservation records will be permanently deleted."
          />
        </Section>
      )}
    </>
  );
}
