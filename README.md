# BookInn — hotel reservation system (Next.js + TypeScript + Supabase Postgres)

Staff web app for the BookInn SRS (revision of 29 Oct 2026): the 11-table 3NF schema, role-based access for
Front Desk, Finance and the Database Administrator, a booking form that records the reservation and its full
payment together, loyalty points and discounts, cancellations, a database-written audit trail, and the daily
completion and one-year retention jobs.

- **SRS conflicts, decisions and assumptions:** [`docs/SRS_AUDIT.md`](docs/SRS_AUDIT.md)
- **Requirement → implementation → test map:** [`docs/REQUIREMENTS_CHECKLIST.md`](docs/REQUIREMENTS_CHECKLIST.md)

BookInn keeps **payment records**; it does not process card, bank or e-wallet transactions. Receipt emails are
**not implemented** (no email provider is configured); receipts can be viewed and printed.

## Quick start

```cmd
npm install
copy .env.example .env.local      &:: fill in DB credentials, SESSION_SECRET and CRON_SECRET
npm run db:migrate                &:: creates/updates schema bookinn
npm run db:seed                   &:: SRS sample data; prints initial staff passwords once
npm run dev                       &:: http://localhost:3000
```

The CLI scripts read `.env.local` first, then `.env`.

| Script | Purpose |
|---|---|
| `npm test` | 59 Vitest tests against a real in-process Postgres (PGlite) using the real migrations. No Supabase needed. |
| `npm run lint` / `npm run typecheck` / `npm run build` | Static checks and production build |
| `npm run db:migrate` | Applies `db/migrations/*.sql` once each (tracked in `bookinn.schema_migrations`) |
| `npm run db:seed` | Seeds only when `bookinn.staff` is empty; never overwrites data. To reseed a dev database, drop schema `bookinn` and migrate again. |

## Roles (SRS §3.3 permission table)

| Data | Front Desk | Finance | Database Administrator |
|---|---|---|---|
| Customers | Create, read, update | Read | All (delete only without dependents) |
| Loyalty accounts | Open (0 pts), read | Read | All, including point corrections |
| Rooms, room types | Read | Read | All |
| Reservations, reserved rooms | Book (with payment), read, cancel | Read | All; corrections are audited |
| Payments, receipts | Recorded with the booking, read | Read | All; corrections are audited |
| Cancellations | Create, read | Read | All |
| Staff | Own name and password | Own name and password | All |
| Audit trail | — | — | Read only |

Every rule is enforced on the server (and by database constraints and triggers), not only by hiding buttons.

## How a booking works

1. Front Desk opens **New booking**, picks an existing guest, the dates, one or more rooms and an optional loyalty discount.
2. **Review booking**: the server checks availability and computes the amount due from `ROOM_DETAILS.ROOM_PRICE × nights`,
   minus the discount (12% of the total for 100 pts, or one night of the most expensive room for 250 pts, never below ₱0).
3. Front Desk collects the money and enters the method and the amount received. It must equal the amount due.
4. **Confirm** saves, in one transaction: the reservation (Booked), its reserved rooms, the payment, the receipt and the
   loyalty balance change (earn = amount ÷ 50 with an account, or spend for a discount, never both).
5. After that, only the status changes: Front Desk can **cancel** (no fee, no refund, points stay final), and the daily job
   marks it **Completed** the day after the latest check-out. No-shows stay Booked. Only the administrator can correct entries.

## Daily maintenance (SRS §3.3)

`bookinn.complete_reservations(today)` and `bookinn.purge_expired_reservations(today)` (migration 0003) run every day at
00:05 Asia/Manila via **Vercel Cron** → `GET /api/cron/maintenance` (see `vercel.json`). The endpoint requires
`Authorization: Bearer <CRON_SECRET>`, which Vercel adds automatically when `CRON_SECRET` is set. The administrator can also
run it from the dashboard. Retention deletes a reservation with its reserved rooms, payment, receipt and cancellation one year
after the latest check-out; customers and loyalty accounts are kept. The deletions are logged in the audit trail with
`STAFF_ID` empty and a "RETENTION" note instead of the deleted data. The job is idempotent.

Alternative without Vercel: schedule the same SQL with Supabase `pg_cron`:
```sql
select cron.schedule('bookinn-daily', '5 16 * * *',
  $$select bookinn.complete_reservations((now() at time zone 'Asia/Manila')::date),
           bookinn.purge_expired_reservations((now() at time zone 'Asia/Manila')::date)$$);
```

## Deploying

1. **Back up Supabase first** (Dashboard → Database → Backups, or `pg_dump`). Migration 0003 converts `STAFF.IS_ACTIVE`
   to Yes/No, removes `CANCELLATION.CANCELLED_BY`, and changes the audit columns. `tests/upgrade.test.ts` checks it on a copy
   of the old schema with data.
2. Run `npm run db:migrate` against Supabase from your machine.
3. In Vercel → Settings → Environment Variables (Production): `SESSION_SECRET`, `CRON_SECRET`, and either `DATABASE_URL` or the
   `SUPABASE_DB_*` variables. Use the **transaction pooler** (port `6543`, user `postgres.<project-ref>`).
4. Deploy, then check Vercel → Settings → Cron Jobs shows `/api/cron/maintenance`.

Security notes: only the Next.js server connects to Postgres; no Supabase keys reach the browser. Row Level Security is enabled
on all 11 tables with no policies, and `anon`/`authenticated` have no access to schema `bookinn`, so the Supabase Data API
cannot read BookInn data. Do not commit `.env*` files.

### Mock logins (sample data)

| Role | Username | Password | What to try |
|---|---|---|---|
| Database Administrator | `ADMIN` | `BkCO6QLnD4XtgaNTnw#7` | Staff, audit trail, rooms, corrections, "Run daily maintenance now" |
| Front Desk | `KDPALVARADO` | `BkpDsxHaxKfF70WMZR#7` | New booking, customers, loyalty accounts, cancelling |
| Finance | `JESMEDEL` | `BkRZnH0AxEWDtb9WZl#7` | Read-only view of payments, receipts, reservations and the dashboard |
| Finance | `ETEGGERE` | `zjTTbS7teXnxHAM_` | Same as above (second Finance account) |

These are mock accounts for trying the system. Usernames are not case-sensitive. **Change the passwords (Account settings)
before real guest data is entered.**

For a new database, `npm run db:seed` prints random passwords once (or uses `SEED_ADMIN_PASSWORD`, `SEED_FRONTDESK_PASSWORD`,
`SEED_FINANCE_PASSWORD`).

### Sample data (SRS §4.2 3NF, corrected)

| Table | Records |
|---|---|
| Customers | 1001 JUAN DELA CRUZ; 1002 KEIZZY ALVARADO |
| Loyalty accounts | 5001 → 1001, 300 pts (120 + 120 + 60); 5002 → 1002, 250 pts |
| Room types / rooms | RT01 Standard, Ocean View ₱1500; RT02 Deluxe, Pool View ₱3000 · rooms 205, 206, 406 (RT01), 108 (RT02) |
| Reservations | 1001 rooms 205+206 Jun 25–27 2026, Completed · 1002 room 108 Aug 8–10, Completed · 1003 room 406 Sep 25–29, Cancelled · 1004 room 206 Dec 20–22, Booked (demo) |
| Payments / receipts | 1001 Digital Wallet ₱6000 +120 · 1002 Cash ₱5280 12% (−100) · 1003 Digital Wallet ₱6000 +120 · 1004 Cash ₱3000 +60 · receipts 1001–1004 |
| Cancellations | 9001 → reservation 1003, Sep 15 2026 |
| Audit trail | The 2 SRS sample rows; every later change is added by the database |

Corrections versus the SRS sample (see `src/lib/db/seed.ts` and SRS_AUDIT A16–A17, A21): ISO dates; 5001 = 240 points before the
demo booking (the 3NF table shows 120); finished stays marked Completed; real bcrypt hashes and an `ADMIN` account; Finance active;
the sample audit row by Finance is attributed to Front Desk; `CANCELLED_BY` removed; demo reservation 1004 added.

## Schema (`db/migrations`)

- `0001_init_schema.sql`: the 11 tables, enums, PK/FK (all `ON DELETE RESTRICT`), uniqueness and CHECK rules.
- `0002_proposed_staff_is_active.sql`: adds `STAFF.IS_ACTIVE` (approved, now in the SRS dictionary).
- `0003_srs_revision.sql`: `IS_ACTIVE` Yes/No; `CANCELLED_BY` removed; `AUDIT_TRAIL` (`STAFF_ID` nullable, `REC_ID varchar(50)`,
  `OLD_DATA`/`NEW_DATA text`); case-insensitive unique usernames; audit triggers on all tables; double-booking trigger with a room
  row lock; daily job functions; RLS.

## Testing

`npm test` covers the 25 acceptance cases from the brief plus schema, seed, upgrade and security checks. Before this handoff the
production build was also smoke-tested over HTTP and in a real browser (Edge) against a local in-memory Postgres: 44/44 checks,
including a full booking with a 12% discount, a rejected wrong amount, cancellation, role-restricted pages and the cron endpoint.

## Layout

```
db/migrations/        SQL migrations (source of truth for the schema)
docs/                 SRS audit and requirements checklist
scripts/              migrate / seed CLIs
src/lib/entities.ts   11 entity definitions: fields, labels, permissions
src/lib/booking.ts    booking + payment + receipt + points in one transaction; cancellation
src/lib/crud.ts       RBAC-checked generic CRUD, search/sort/pagination, delete guard, DB-error mapping
src/lib/rules.ts      business rules for administrator corrections and generic forms
src/lib/maintenance.ts daily completion and retention jobs
src/app/              Next.js App Router pages, Server Actions, /api/cron/maintenance
tests/                Vitest suites (PGlite)
```
