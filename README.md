# BookInn — Phase 1 CRUD prototype (Next.js + TypeScript + Supabase Postgres)

Staff web app implementing the 11 entities of the BookInn SRS final 3NF schema (§4.2 3NF, §4.4 Data Dictionary) with create/read/update/delete, secure staff login, RBAC, an audit trail, and safe-delete guards.

> **⚠ Not yet implemented — customer data retention (SRS §3.3):** automatic deletion of customer records after 1 year of inactivity is **not implemented in Phase 1**. No scheduled jobs, triggers or cascades delete customers. Staff can delete a customer by hand only when no reservations, payments, loyalty account or other records reference it. This is a temporary Phase 1 limitation, not a change to the SRS, and is planned for a later phase.

Next.js is the project's only stack; the earlier PHP prototype has been removed (it remains in git history). All tables live in a dedicated Postgres schema, `bookinn`, so they never collide with the old PHP tables that may still exist in Supabase's `public` schema.

## Quick start

```cmd
npm install
copy .env.example .env.local      &:: fill in DB credentials + SESSION_SECRET
npm run db:migrate                &:: creates schema bookinn and the 11 tables
npm run db:seed                   &:: corrected SRS sample data; prints initial staff passwords once
npm run dev                       &:: http://localhost:3000
```

The CLI scripts read `.env.local` first, then `.env` (your existing `SUPABASE_DB_*` variables work as-is).

| Script | Purpose |
|---|---|
| `npm test` | 32 Vitest tests against a real in-process Postgres (PGlite) using the real migrations. No Supabase needed. |
| `npm run lint` / `npm run typecheck` / `npm run build` | Static checks and production build |
| `npm run db:migrate` | Applies `db/migrations/*.sql` once each (tracked in `bookinn.schema_migrations`) |
| `npm run db:seed` | Seeds only when `bookinn.staff` is empty. It never overwrites data. |

### Seed logins

| Username | Role |
|---|---|
| `ADMIN` | Database Administrator |
| `KDPALVARADO` | Front Desk |
| `JESMEDEL` | Finance |

Passwords come from `SEED_*_PASSWORD` env vars. If those are unset, random passwords that meet the policy are generated and printed once. No passwords are stored in source code.

## Deploying to Vercel

1. Add environment variables: `SESSION_SECRET` (≥ 32 random chars) plus either `DATABASE_URL` or `SUPABASE_DB_HOST/PORT/NAME/USER/PASSWORD/SSLMODE`. Use the Supabase **transaction pooler** (port `6543`, user `postgres.<project-ref>`).
2. Run `npm run db:migrate` and `npm run db:seed` from your machine against Supabase before the first deploy.

## Schema (db/migrations)

`0001_init_schema.sql` follows the data dictionary for every table, column, type, PK and FK.

- **Enums**: native Postgres `ENUM`s with exactly the dictionary's allowed values.
- **IDs**: `int` identity columns that start at the SRS sample numbering (1001 / 5001 / 9001 / 10001). `ROOM.ROOM_NO` and `ROOM_DETAILS.ROOM_TYPE_ID` are natural keys, as documented.
- **Foreign keys**: all 9 are `ON DELETE RESTRICT ON UPDATE RESTRICT`. There is **no `ON DELETE CASCADE` anywhere**. A test asserts this.
- **Constraints**: dictionary notes and §3.3 business rules become DB constraints. These add no new columns:
  - unique customer email
  - check-out date after check-in date
  - unique username
  - one loyalty account per customer
  - one payment per reservation (one-time payment rule)
  - one receipt per payment
  - one cancellation per reservation
  - a payment can't both earn and spend points
  - discount ↔ points: 12% = 100 pts, Free Night = 250 pts
  - non-negative amounts and points
  - `STAFF.PASS` must be a bcrypt hash
- **Audit trail**: `AUDIT_TRAIL` is append-only. A trigger blocks UPDATE and DELETE.

## Proposed structural change (needs your approval)

| # | Change | Why | File |
|---|---|---|---|
| P1 | Add `STAFF.IS_ACTIVE boolean NOT NULL DEFAULT true` | FR-02 and §3.3 require deactivating accounts so they can't log in while their history is kept. The dictionary's STAFF table has no column for this, and audit FKs prevent deleting staff. | `0002_proposed_staff_is_active.sql` (additive; rollback is in the file) |

If you reject P1, delete that migration. Login and the Staff form then need the `is_active` references removed.

### Interpretations (no structural change)

- **RBAC roles**: these use the dictionary's values (`Front Desk`, `Finance`, `Database Administrator`). §3.3 also says "Administrator", which I mapped to Database Administrator.
- **Permissions**:
  - Front Desk writes Customers, Rooms, Room types, Reservations, Reservation rooms and Cancellations.
  - Finance writes Payments and Receipts.
  - Both can create loyalty accounts.
  - The Administrator can do everything, and is the only role that can see Staff and the Audit trail.
  - Every role can read the operational tables.
- **Audit `REC_ID`**: this column is `int`, so audit rows for `ROOM_DETAILS` (which has a `varchar(4)` key) store `NULL` there. The key goes into `OLD_DATA`/`NEW_DATA` instead (e.g. `ROOM_TYPE_ID=RT09; …`).
- **Cancelling**: you cancel a reservation by creating a `CANCELLATION` record. This sets the reservation to Cancelled and frees its rooms. Deleting the cancellation reinstates the booking, but only if the rooms are still free.

## Sample-data corrections (applied in `src/lib/db/seed.ts`)

| # | SRS sample | Seeded | Reason |
|---|---|---|---|
| C1 | Mixed date formats (`06-25-2026`, `9-25-2026`) | ISO `2026-09-25` | Postgres `date` needs one unambiguous format |
| C2 | `LOYALTY_ACC` 5001 `TOTAL_PTS = 120` | `240` | Customer 1001 earned 120 points on payment 1001 and another 120 on payment 1003. Points stay final even after a cancellation (§3.3), and the UNF table already shows 240. |
| C3 | Reservations 1001 and 1002 `Booked` | `Completed` | Both stays ended (June 27 and Aug 10) before the SRS date (Sept 2026). Left as Booked, they would still block those rooms. |
| C4 | `PASS = [HashedPass1]`, and no administrator account | Real bcrypt hashes, plus an `ADMIN` account | Placeholders can't authenticate, and only an administrator can manage staff |

I checked the rest of the sample data and kept it as-is:
- Payment amounts: 6000 = 2 rooms × 2 nights × ₱1500; 5280 = 6000 − 12%.
- Points: 6000 / 50 = 120.
- Receipts match payments 1:1.
- The cancellation and both audit rows.

## What the app enforces

- **Authentication**:
  - bcrypt passwords (cost 12) and a policy check (upper, lower, digit, special character, 8–72 characters).
  - HttpOnly, SameSite=Lax session cookie, signed as an HS256 JWT, valid for 8 hours.
  - The staff row is re-checked on every request, so deactivating an account or changing its role takes effect immediately.
  - Login does the same work whether or not the username exists, so response time doesn't reveal valid usernames.
  - Staff can change their own password (FR-03).
- **Authorization**: every Server Action re-authenticates the caller, and the CRUD layer re-checks RBAC, whatever the UI showed. SQL identifiers come only from the static entity map, and every value is a bound parameter.
- **Safe delete**: a delete is refused, with a count of the dependent records, while anything still references the row. The DB `RESTRICT` constraint backs this up.
- **Admin lockout guard**: an administrator can't delete, demote or deactivate their own account, and the last active administrator can't be removed.
- **Bookings**:
  - Double-booking check (FR-15/16): only `Booked` reservations count, the room row is locked to stop races, and back-to-back stays are allowed.
  - Once a reservation is paid, its rooms and guest are locked (FR-14).
- **Payments**:
  - Amount must equal the amount due: overpayment and partial payment are both rejected.
  - Points earned are computed on the server as floor(amount / 50).
  - Discounts need a loyalty account with enough points.
  - A receipt is created automatically.
- **Audit**: every insert, update and delete writes an `AUDIT_TRAIL` row in the same transaction. Password hashes are never logged.

## Deferred (not in Phase 1)

- **Automatic customer deletion after 1 year of inactivity** (SRS §3.3 Data Retention). This is deliberately not implemented: there are no jobs, triggers or cascades that delete customers. Staff can delete a customer by hand only when no reservations, loyalty account or other records reference it. This is a temporary Phase 1 limitation, and the policy stays in the SRS for a later phase.
- Deducting and crediting loyalty points against `TOTAL_PTS` when a payment is posted. `PTS_EARN`/`PTS_SPEND` are recorded, but the balance is edited manually for now.
- Automated no-shows, email receipts and notifications, the online guest booking portal, reports, 1-year history limits, and rate limiting on login.

## Layout

```
db/migrations/        SQL migrations (source of truth for the schema)
scripts/              migrate / seed CLIs
src/lib/entities.ts   11 entity definitions (fields, labels, RBAC) driving all screens
src/lib/crud.ts       generic RBAC-checked CRUD, delete guard, DB-error mapping
src/lib/rules.ts      SRS business rules (double booking, payments, cancellations, staff)
src/lib/staff-auth.ts bcrypt login, session token, password change
src/app/              Next.js App Router pages and Server Actions
tests/                Vitest suites (PGlite)
```
