import Link from "next/link";
import { getDb } from "@/lib/db/pg";
import { requireStaff } from "@/lib/session";
import { dashboardStats, dashboardTrends, roomAvailability } from "@/lib/dashboard";
import { DBA, ENTITIES, can } from "@/lib/entities";
import { addDays, hotelToday } from "@/lib/dates";
import { isRealDate } from "@/lib/validation";
import { peso } from "@/lib/money";
import { canViewOverdue, listOverdue } from "@/lib/overdue";
import { runMaintenanceAction } from "@/app/actions";
import { ConfirmButton } from "@/components/forms";
import { Icon, type IconName } from "@/components/icons";
import { AvailabilityBar, CountUp, PaymentsChart, ReservationsChart, StatusBars } from "@/components/dashboard-charts";
import { EmptyState, Section, StatusBadge } from "@/components/ui";

/** "+12% vs …" in neutral ink (status colours are reserved for status). */
function Delta({ now, before, label }: { now: number; before: number; label: string }) {
  if (before === 0) return <span className="text-xs text-muted">{now > 0 ? `New ${label}` : `No change ${label}`}</span>;
  const pct = Math.round(((now - before) / before) * 100);
  return (
    <span className="text-xs text-muted">
      <span className="font-semibold text-ink">{pct > 0 ? "↑" : pct < 0 ? "↓" : "→"} {Math.abs(pct)}%</span> {label}
    </span>
  );
}

function StatCard({
  href, icon, label, value, children, accent, delay,
}: { href?: string; icon: IconName; label: string; value: React.ReactNode; children?: React.ReactNode; accent?: boolean; delay: number }) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <span className={`text-sm ${accent ? "text-brand-100" : "text-muted"}`}>{label}</span>
        <span className="stat-icon"><Icon name={icon} size={18} /></span>
      </div>
      <div className={`mt-2 text-3xl font-semibold tabular-nums ${accent ? "text-white" : "text-brand-900"}`}>{value}</div>
      <div className={`mt-2 ${accent ? "[&_*]:!text-brand-100" : ""}`}>{children}</div>
    </>
  );
  const cls = `stat-card animate-in ${accent ? "stat-card-accent" : ""}`;
  return href ? (
    <Link href={href} className={cls} style={{ animationDelay: `${delay}ms` }}>{body}</Link>
  ) : (
    <div className={cls} style={{ animationDelay: `${delay}ms` }}>{body}</div>
  );
}

export default async function Dashboard({ searchParams }: PageProps<"/">) {
  const staff = await requireStaff();
  const actor = { staffId: staff.staffId, role: staff.role };
  const sp = await searchParams;
  const db = getDb();
  const today = hotelToday();

  const from = typeof sp.from === "string" && isRealDate(sp.from) ? sp.from : today;
  const toRaw = typeof sp.to === "string" && isRealDate(sp.to) ? sp.to : addDays(from, 1);
  const to = toRaw > from ? toRaw : addDays(from, 1);
  const [s, t, rooms, overdueRows] = await Promise.all([
    dashboardStats(db, actor, today),
    dashboardTrends(db, actor, today),
    roomAvailability(db, actor, from, to, today),
    canViewOverdue(actor) ? listOverdue(db, actor, today) : Promise.resolve(null),
  ]);
  const canBook = can(staff.role, ENTITIES.reservation, "create");
  const reserved = Math.max(0, s.rooms - s.availableTonight - t.occupiedNow);
  const custom = from !== today || to !== addDays(today, 1);

  return (
    <>
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1>Dashboard</h1>
          <p className="mt-1 text-sm text-muted">Hello, {staff.name.split(" ")[0]}. Here is the hotel on {today} (PHT).</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <form action="/reservation" role="search" aria-label="Search reservations" className="relative">
            <Icon name="search" size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input name="q" type="search" placeholder="Search reservations…" aria-label="Search reservations" className="w-56 rounded-full pl-9" />
          </form>
          {canBook && <Link href="/book" className="btn btn-primary"><Icon name="booking" size={16} /> New booking</Link>}
        </div>
      </header>

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard href="/payment" icon="bookings" label="New bookings · last 7 days" value={<CountUp value={t.bookings7} />} accent delay={0}>
          <Delta now={t.bookings7} before={t.bookingsPrev7} label="vs the 7 days before" />
        </StatCard>
        <StatCard href="/reservation?booking_status=Booked" icon="checkIn" label="Arrivals today" value={<CountUp value={t.arrivalsToday} />} delay={60}>
          <span className="text-xs text-muted">{t.arrivalsCheckedIn} of {t.arrivalsToday} room{t.arrivalsToday === 1 ? "" : "s"} checked in</span>
        </StatCard>
        <StatCard href="/reservation?booking_status=Checked-In" icon="checkOut" label="Departures today" value={<CountUp value={t.departuresToday} />} delay={120}>
          <span className="text-xs text-muted">{t.departuresCheckedOut} of {t.departuresToday} room{t.departuresToday === 1 ? "" : "s"} checked out</span>
        </StatCard>
        <StatCard href="/payment" icon="revenue" label="Payments this month" value={<CountUp value={s.revenueThisMonthCents} format="peso" />} delay={180}>
          <Delta now={s.revenueThisMonthCents} before={t.revenueLastMonthCents} label="vs last month" />
        </StatCard>
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-[1fr_1.6fr]">
        <section className="card animate-in" aria-labelledby="avail-h" style={{ animationDelay: "120ms" }}>
          <div className="mb-4 flex items-center justify-between gap-2">
            <h2 id="avail-h" className="flex items-center gap-2"><Icon name="bed" /> Rooms tonight</h2>
            <Link href="/room" className="text-sm">{s.rooms} rooms</Link>
          </div>
          <AvailabilityBar occupied={t.occupiedNow} reserved={reserved} available={s.availableTonight} />
          <p className="mt-4 text-xs text-muted">
            Computed from reservation dates and check-in and check-out events. {s.upcoming} upcoming stay{s.upcoming === 1 ? "" : "s"} booked after today.
          </p>
        </section>

        <section className="card animate-in" aria-labelledby="pay-h" style={{ animationDelay: "180ms" }}>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="pay-h" className="flex items-center gap-2"><Icon name="payments" /> Payments recorded</h2>
            <span className="text-xs text-muted">Last 7 days · <span className="font-semibold text-ink">{peso(t.payments7Cents)}</span> <Delta now={t.payments7Cents} before={t.paymentsPrev7Cents} label="vs the 7 days before" /></span>
          </div>
          <PaymentsChart days={t.days} />
        </section>
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <section className="card animate-in" aria-labelledby="res-h" style={{ animationDelay: "220ms" }}>
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <h2 id="res-h" className="flex items-center gap-2"><Icon name="bookings" /> Reservations</h2>
            <span className="text-xs text-muted">Last 7 days</span>
          </div>
          <ReservationsChart days={t.days} />
        </section>

        <section className="card animate-in" aria-labelledby="status-h" style={{ animationDelay: "260ms" }}>
          <div className="mb-4 flex items-baseline justify-between gap-2">
            <h2 id="status-h">By status</h2>
            <Link href="/reservation" className="text-sm">All reservations</Link>
          </div>
          <StatusBars
            items={[
              { label: "Booked", n: s.booked, href: "/reservation?booking_status=Booked" },
              { label: "Checked-In", n: s.checkedIn, href: "/reservation?booking_status=Checked-In" },
              { label: "Completed", n: s.completed, href: "/reservation?booking_status=Completed" },
              { label: "Cancelled", n: s.cancelled, href: "/reservation?booking_status=Cancelled" },
              { label: "No-Show", n: s.noShow, href: "/reservation?booking_status=No-Show" },
            ]}
          />
          {overdueRows !== null && (
            <Link href="/overdue" className="mt-5 flex items-center justify-between gap-2 rounded-lg border border-[#f0d9a8] bg-warn-soft px-3 py-2 text-sm text-warn no-underline hover:no-underline">
              <span className="flex items-center gap-2"><Icon name="overdue" size={16} /> Overdue</span>
              <span className="font-semibold"><CountUp value={overdueRows.length} /></span>
            </Link>
          )}
        </section>
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <Section title="Current and upcoming stays" actions={<Link href="/reservation?booking_status=Booked" className="text-sm">All Booked</Link>}>
          {s.nextArrivals.length === 0 ? (
            <EmptyState title="No booked stays" />
          ) : (
            <ul className="divide-y divide-line">
              {s.nextArrivals.map((a, i) => (
                <li key={`${a.res_id}-${a.room_no}`} className="animate-in flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm" style={{ animationDelay: `${300 + i * 40}ms` }}>
                  <span className="flex items-center gap-3">
                    <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-800">{a.room_no}</span>
                    <span>
                      <Link href={`/reservation/${a.res_id}`} className="font-medium">{a.cus_name}</Link>
                      <span className="block text-xs text-muted">Reservation #{a.res_id} · Room {a.room_no}</span>
                    </span>
                  </span>
                  <span className="text-muted">
                    {a.check_in_date} → {a.check_out_date} {a.check_in_date <= today && <StatusBadge value="Due in" />}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="At a glance">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            {[
              { k: "Customers", v: s.customers, href: "/customer" },
              { k: "Rooms checked in", v: s.inHouse, href: "/reservation?booking_status=Checked-In" },
              { k: "Loyalty accounts", v: s.loyaltyAccounts, href: "/loyalty_acc", sub: `${s.loyaltyPoints.toLocaleString("en-PH")} points outstanding` },
              { k: "Payments recorded", v: s.payments, href: "/payment" },
            ].map((x) => (
              <Link key={x.k} href={x.href} className="rounded-lg border border-line px-3 py-2 text-ink no-underline transition-colors hover:border-brand-400 hover:no-underline">
                <dt className="text-xs text-muted">{x.k}</dt>
                <dd className="text-xl font-semibold text-brand-900"><CountUp value={x.v} /></dd>
                {x.sub && <dd className="text-[11px] text-muted">{x.sub}</dd>}
              </Link>
            ))}
            <div className="col-span-2 rounded-lg border border-line px-3 py-2">
              <dt className="text-xs text-muted">Revenue recorded (all payments)</dt>
              <dd className="text-xl font-semibold text-brand-900"><CountUp value={s.revenueCents} format="peso" /></dd>
            </div>
          </dl>
        </Section>
      </div>

      <Section title="Room availability by date" id="availability">
        <form className="mb-4 flex flex-wrap items-end gap-3" role="search" aria-label="Check availability" action="/#availability">
          <div className="grid gap-1">
            <label htmlFor="from">Check-in</label>
            <input id="from" name="from" type="date" defaultValue={from} className="w-auto" />
          </div>
          <div className="grid gap-1">
            <label htmlFor="to">Check-out</label>
            <input id="to" name="to" type="date" defaultValue={to} className="w-auto" />
          </div>
          <button type="submit" className="btn btn-secondary"><Icon name="search" size={16} /> Check</button>
          {custom && <Link href="/" className="btn btn-ghost">Tonight</Link>}
          <span className="ml-auto text-xs text-muted">{from} → {to} · {rooms.filter((r) => r.available).length} of {rooms.length} free</span>
        </form>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
          {rooms.map((r, i) => (
            <div
              key={r.room_no}
              className={`animate-in rounded-lg border px-3 py-2 text-sm ${r.available ? "border-line bg-white" : "border-[#f5c2bd] bg-danger-soft/60"}`}
              style={{ animationDelay: `${Math.min(i, 24) * 12}ms` }}
            >
              <div className="flex items-center justify-between">
                <span className="font-semibold text-brand-900">{r.room_no}</span>
                {r.available ? (
                  <span className="badge bg-brand-200 text-brand-900">Free</span>
                ) : (
                  <Link href={`/reservation/${r.blocked_by}`} className="badge bg-danger-soft text-danger">#{r.blocked_by}</Link>
                )}
              </div>
              <div className="mt-0.5 text-xs text-muted">{r.room_type}, {r.room_view}</div>
              <div className="text-xs">₱{r.room_price}/night</div>
            </div>
          ))}
        </div>
        {canBook && rooms.some((r) => r.available) && from >= today && (
          <Link href={`/book?check_in_date=${from}&check_out_date=${to}`} className="btn btn-primary mt-4">
            <Icon name="booking" size={16} /> Book these dates
          </Link>
        )}
      </Section>

      {staff.role === DBA && (
        <Section title="Daily job">
          <p className="mb-4 text-sm text-muted">
            Runs automatically every day at 00:05 (PHT, UTC+8). In order: sets Booked reservations whose stay has passed with no
            check-in to No-Show (and emails the guest), completes stays with nothing left checked in, expected or unpaid, and
            deletes reservation records one year after their latest check-out (skipping any with Unpaid charges).
          </p>
          <ConfirmButton
            action={runMaintenanceAction}
            label="Run the daily job now"
            pendingLabel="Running…"
            variant="secondary"
            confirmText="Run the daily job now? No-Show notices may be emailed and expired reservation records will be permanently deleted."
          />
        </Section>
      )}
    </>
  );
}
