# BookInn — hotel reservation system (Next.js + TypeScript + Supabase Postgres)

Staff web app for the BookInn SRS **v2 (November 2026)**: the 13-table 3NF schema, role-based access for Front Desk,
Finance and the Database Administrator, bookings paid upfront, check-in and check-out per room, reservation edits and
stay extensions posted as charges, one Checkout payment (or Checkout Credit) at check-out, guest cancellations with a
48-hour full-refund rule, loyalty points credited at Completed, an overdue list, emails through Resend, a
database-written audit trail, and one daily job (No-Show, Completed, one-year retention).

- **Source of truth:** [`docs/SRS_v2.md`](docs/SRS_v2.md) (SRS Sections 1–4)
- **Decisions where the SRS is silent:** [`docs/SRS_AUDIT.md`](docs/SRS_AUDIT.md)
- **Requirement → implementation → test map:** [`docs/REQUIREMENTS_CHECKLIST.md`](docs/REQUIREMENTS_CHECKLIST.md)

BookInn keeps **payment and refund records**; it does not process card, bank or e-wallet transactions.

## Quick start

```cmd
npm install
copy .env.example .env.local      &:: fill in DB credentials, SESSION_SECRET and CRON_SECRET (Resend is optional)
npm run db:migrate                &:: creates/updates schema bookinn (migrations 0001–0005)
npm run db:seed                   &:: SRS sample data; prints initial staff passwords once
npm run dev                       &:: http://localhost:3000
```

The CLI scripts read `.env.local` first, then `.env`.

| Script | Purpose |
|---|---|
| `npm test` | 123 Vitest tests against a real in-process Postgres (PGlite) using the real migrations. Resend is mocked; no Supabase needed. |
| `npm run lint` / `npm run typecheck` / `npm run build` | Static checks and production build |
| `npm run db:migrate` | Applies `db/migrations/*.sql` once each (tracked in `bookinn.schema_migrations`) |
| `npm run db:seed` | Seeds only when `bookinn.staff` is empty; never overwrites data. To reseed a dev database, drop schema `bookinn` and migrate again. |

## Roles (SRS v2 Table 2)

| Data | Front Desk | Finance | Database Administrator |
|---|---|---|---|
| Customers, loyalty accounts | Create, read, update (loyalty: open at 0 pts; points change only through payments) | Read | All |
| Rooms, room types | Read | Read | All, except `ROOM_PRICE` (fixed when the room type is created). Can add room type names and views. |
| Reservations, reserved rooms | Book, read, edit (before the 48-hour cutoff), cancel, check in, check out, extend | Read | All (corrections are audited) |
| Payments, receipts | Create (Initial at booking, Checkout at check-out), read | Read | All |
| Charges (edit and extension) | Create, read, settle or void (through edit, extension, check-out, cancellation) | Read | All |
| Refunds | Create (cancellation, Checkout Credit), read | Read | All |
| Cancellations | Create, read | Read | All |
| Overdue list | — | Read | Read |
| Staff | Own name and password | Own name and password | All |
| Audit trail | — | — | Read only |

Every rule is enforced on the server (and by database constraints and triggers), not only by hiding buttons.

## How a stay works

1. **Book** (Front Desk, *New booking*): pick a guest, rooms and dates, and an optional loyalty discount (100 pts = 12%,
   250 pts = one free night of the most expensive room). The amount due is computed from `ROOM_DETAILS.ROOM_PRICE ×
   nights`. The guest pays upfront; the **Initial payment** and its receipt are saved with the reservation (Booked), spent
   points are deducted, and the receipt is emailed.
2. **Edit** (reservation page, while Booked and until 48 hours before the earliest check-in at 14:00): change rooms or
   dates, add or remove rooms. Changed rooms are re-priced at the room rate; the difference is an Unpaid **Modification
   charge** (negative for a decrease), paid at check-out.
3. **Check in** each room on or after its check-in date → the reservation becomes **Checked-In**.
4. **Extend** (only while Checked-In): in the same room if its next nights are free, otherwise in another room. The extra
   nights are an Unpaid **Extension charge**.
5. **Check out** each room. Leaving early shortens the stay and voids unused extension nights (no refund of prepaid nights).
6. **Settle** at the check-out that leaves no room checked in: the Unpaid charges are paid in **one Checkout payment**, or,
   if they add up to less than zero, a **Checkout Credit** refund is recorded. Receipt or refund confirmation is emailed.
7. **Completed** as soon as no room is checked in or still expected and nothing is Unpaid. Earned points (payment ÷ 100)
   are credited then.

**Cancel** (guest request, only while Booked): at least 48 hours before the earliest check-in at 14:00 → 100% refund of
the amount paid (refund confirmation emailed); later → no refund. Spent points are always returned; earned points are
never credited. Unpaid edit charges are voided.

## Daily job

One job runs every day at **00:05 Asia/Manila** via **Vercel Cron** → `GET /api/cron/maintenance`. Vercel Cron schedules are
in UTC, so `vercel.json` uses `"5 16 * * *"` (16:05 UTC = 00:05 UTC+8; Manila has no daylight saving time). In order:

1. **No-Show**: Booked reservations whose latest check-out is before today and that have no room checked in. Their Unpaid
   charges are voided. After the transaction commits, each guest gets the **No-Show notice** by email.
2. **Completed**: Checked-In reservations with no room checked in, none still expected, and no Unpaid charge (points credited).
3. **Retention**: reservations whose latest check-out is one year or more before today are deleted with all their records
   (rooms, payments, receipts, charges, refunds, cancellation), except those with an Unpaid charge. Guests, loyalty accounts
   and the audit trail are kept. Deletions are logged with `STAFF_ID` empty and a "RETENTION" note.

The **overdue list** (Finance and the administrator, *Payments → Overdue*) is a database view computed every time it is
opened: latest check-out before today and still Checked-In or with an Unpaid charge. It is not stored or scheduled.

The endpoint requires `Authorization: Bearer <CRON_SECRET>`, which Vercel adds automatically when `CRON_SECRET` is set.
The administrator can also run it from the dashboard (*Run the daily job now*).

**Run the daily job locally** (dev server running, `CRON_SECRET` set in `.env.local`):

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/maintenance
```

On Windows PowerShell:

```powershell
Invoke-RestMethod http://localhost:3000/api/cron/maintenance -Headers @{ Authorization = "Bearer $env:CRON_SECRET" }
```

Alternative without Vercel: schedule the same SQL with Supabase `pg_cron` (No-Show emails are then not sent, because email
is sent by the app):

```sql
select cron.schedule('bookinn-daily', '5 16 * * *',
  $$select bookinn.mark_no_shows((now() at time zone 'Asia/Manila')::date),
           bookinn.complete_reservations((now() at time zone 'Asia/Manila')::date),
           bookinn.purge_expired_reservations((now() at time zone 'Asia/Manila')::date)$$);
```

## Email (Resend)

Receipts (every payment), refund confirmations (every refund) and No-Show notices are sent with the official
[`resend`](https://www.npmjs.com/package/resend) package to the guest's email. Set `RESEND_API_KEY` and `RESEND_FROM_EMAIL`
(a sender on a domain verified in Resend, e.g. `BookInn <bookings@your-domain.com>`) in `.env.local` and in Vercel.
Without them, emails are skipped and logged. Emails are sent only after the database transaction commits, and an email
failure is logged and never undoes a booking, payment, refund or the daily job. **Before enabling Resend, change the sample
guests' emails** (`jdcruz@gmail.com`, `kdpalvarado@gmail.com`) to addresses you control.

## Deploying

1. **Back up Supabase first** (Dashboard → Database → Backups, or `pg_dump`). Migrations 0004–0005 add the new statuses,
   tables and rules and convert existing rows (see `docs/SRS_AUDIT.md` B1). `tests/upgrade.test.ts` checks them on a copy of
   the old schema with data.
2. Run `npm run db:migrate` against Supabase from your machine.
3. In Vercel → Settings → Environment Variables (Production): `SESSION_SECRET`, `CRON_SECRET`, `RESEND_API_KEY`,
   `RESEND_FROM_EMAIL`, and either `DATABASE_URL` or the `SUPABASE_DB_*` variables. Use the **transaction pooler** (port
   `6543`, user `postgres.<project-ref>`).
4. Deploy, then check Vercel → Settings → Cron Jobs shows `/api/cron/maintenance`.

Security notes: only the Next.js server connects to Postgres; no Supabase keys reach the browser. Row Level Security is enabled
on all 13 tables with no policies, and `anon`/`authenticated` have no access to schema `bookinn`, so the Supabase Data API
cannot read BookInn data. Do not commit `.env*` files.

### Mock logins (sample data)

| Role | Username | Password | What to try |
|---|---|---|---|
| Database Administrator | `ADMIN` | `BkCO6QLnD4XtgaNTnw#7` | Staff, audit trail, rooms, room types and views, corrections, overdue list, "Run the daily job now" |
| Front Desk | `KDPALVARADO` | `7rVTSNTSt7RN!7` | New booking, edit, check in, extend, check out, settle, cancel, customers, loyalty accounts |
| Finance | `JESMEDEL` | `BkRZnH0AxEWDtb9WZl#7` | Read-only payments, receipts, charges, refunds, reservations, overdue list and the dashboard |
| Finance | `ETEGGERE` | `PAWcKwAku5qK!7` | Same as above (second Finance account) |

These are mock accounts for trying the system. Usernames are not case-sensitive. **Change the passwords (Account settings)
before real guest data is entered.**

`npm run db:seed` creates all four accounts with bcrypt hashes in `STAFF.PASS`. To get exactly the passwords above, set
`SEED_ADMIN_PASSWORD`, `SEED_FRONTDESK_PASSWORD`, `SEED_FINANCE_PASSWORD` and `SEED_FINANCE2_PASSWORD` before seeding;
otherwise random passwords are generated and printed once.

### Sample data (SRS v2 Tables 7–19)

| Table | Records |
|---|---|
| Customers | 1001 JUAN DELA CRUZ; 1002 KEIZZY ALVARADO |
| Loyalty accounts | 5001 → 1001, 75 pts (60 + 15); 5002 → 1002, 250 pts |
| Room types / rooms | RT01 Standard, Ocean View ₱1500; RT02 Deluxe, Pool View ₱3000 · rooms 205, 206, 406 (RT01), 108 (RT02) |
| Reservations | 1001 Completed (205 Jun 25–28 incl. extension, 206 Jun 25–27, checked in and out) · 1002 Booked (108 Oct 8–11) · 1003 Cancelled (406 Sep 25–29) · 1004 Booked (206 Dec 20–22, demo, not in the SRS) |
| Payments / receipts | 1001 Initial ₱6000 · 1002 Initial ₱5280 (12%, −100 pts) · 1003 Initial ₱6000 · 1004 Checkout ₱1500 (for 1001) · 1005 Initial ₱3000 (demo) · receipts 1001–1005 |
| Charges | 7001 Extension 1001/room 205, ₱1500, Paid by 1004 · 7002 Modification 1002, ₱3000, Unpaid |
| Refunds / cancellations | 8001 Cancellation 1003 ₱6000 · 9001 → 1003, Sep 15 2026 |
| Audit trail | The 5 SRS sample rows; every later change is added by the database |

Differences from the SRS sample (see `src/lib/db/seed.ts`): ISO dates, real bcrypt hashes, JESMEDEL active, `ADMIN` and
`ETEGGERE` added, demo reservation 1004. Note that the sample is a snapshot of 2026-09-15: on a later date the first daily
job sets reservation 1002 to No-Show.

## Schema (`db/migrations`)

- `0001_init_schema.sql`: the original 11 tables, enums, keys, uniqueness and CHECK rules.
- `0002_proposed_staff_is_active.sql`: adds `STAFF.IS_ACTIVE`.
- `0003_srs_revision.sql`: `IS_ACTIVE` Yes/No; `CANCELLED_BY` removed; audit columns; audit triggers; double-booking trigger; RLS.
- `0004_srs_v2_enums.sql`: statuses Checked-In and No-Show; audit tables ADJUSTMENT_CHARGE and REFUND; new enum types.
- `0005_srs_v2_schema.sql`: `PAYMENT.PAY_TYPE` (one Initial, at most one Checkout), `ACTUAL_CHECK_IN/OUT`,
  `ADJUSTMENT_CHARGE`, `REFUND`, Table 20 delete rules with a purge-only guard, fixed `ROOM_PRICE`, room type lock,
  double booking for Booked and Checked-In, status rules, points at Completed, the overdue view, the daily job functions,
  data conversion, audit triggers and RLS for the new tables.

## Layout

```
db/migrations/           SQL migrations (source of truth for the schema)
docs/                    SRS v2, SRS audit and requirements checklist
scripts/                 migrate / seed CLIs
src/lib/entities.ts      13 entity definitions: fields, labels, permissions
src/lib/booking.ts       booking + Initial payment + receipt; guest cancellation with refund
src/lib/modify.ts        reservation edits (Modification charges)
src/lib/stay.ts          check-in, extension, check-out, Checkout payment / Checkout Credit
src/lib/rules.ts         shared business rules and administrator corrections
src/lib/email.ts         Resend: receipts, refund confirmations, No-Show notices
src/lib/overdue.ts       overdue list (database view)
src/lib/maintenance.ts   daily job (No-Show, Completed, retention) + No-Show emails
src/lib/crud.ts          RBAC-checked generic CRUD, search/sort/pagination, delete guard, DB-error mapping
src/app/                 Next.js App Router pages, Server Actions, /api/cron/maintenance
tests/                   Vitest suites (PGlite)
```
