# BookInn — Hotel Reservation System

A simple hotel reservation management system built with **PHP + PostgreSQL**, using **Supabase** as the managed Postgres database host, deployable to **Vercel** via the community `vercel-php` runtime.

## Features

- Guest management
- Room & room type management (with maintenance lock)
- Reservations with overlap/double-booking prevention
- Payments with auto receipt generation, payment status tracking, and an enforced overpayment guard
- Hold expiration: unpaid `Pending` reservations auto-cancel after 48h and release the room
- Role-based access control (Administrator, Front Desk Staff, Finance Officer)
- Reports (Admin / Finance Officer only)
- Audit logging (access attempts + cancellations)
- Database-backed sessions (works across stateless/serverless PHP invocations on Vercel)

## Requirements

- **PHP 8.x** (tested on PHP 8.2) with the **`pdo_pgsql`** extension enabled
  - On Windows, uncomment `extension=pdo_pgsql` in `php.ini`
  - A local web server for PHP (e.g. `php -S localhost:8000` from the project root, or Apache/Nginx + PHP-FPM)
- A **Supabase** project (free tier is enough) — [https://supabase.com/](https://supabase.com/)
  - You only need the project's Postgres **database connection string / parameters**, not the JS client libraries, since this app talks to Postgres directly over PDO.
- A **Vercel** account (free tier is enough) if deploying — [https://vercel.com/](https://vercel.com/)
- A web browser
- (Optional) VS Code with the **SQLTools** + **SQLTools PostgreSQL/CockroachDB** extensions, if you want to run SQL directly from the editor

## Project Structure

```
.env.example                  # Template for Supabase DB credentials (copy to .env)
vercel.json                   # Vercel PHP runtime + clean-URL route config
.vercelignore                 # Files excluded from the Vercel deployment
api/                          # Every page lives here (Vercel serverless-function convention)
├── index.php
├── login.php
├── logout.php
├── dashboard.php
├── customers.php              # Guest management
├── rooms.php                  # Room & room type management
├── reservations.php
├── payments.php
├── staff.php                  # Admin only
└── reports.php                 # Admin / Finance Officer only
assets/
└── style.css
database/
├── schema.sql                # Run this first to create tables in your Supabase DB
└── seed_passwords.php        # Run once to set default account passwords
includes/
├── db.php                    # Database connection (reads Supabase creds from .env / env vars)
├── auth.php                  # Login/session/RBAC logic
├── db_session_handler.php    # DB-backed PHP session handler (APP_SESSION table)
├── functions.php             # Business rules (overlap check, status sync, hold expiration, etc.)
├── header.php
└── footer.php
```

Every page under `api/` is treated by Vercel as its own serverless function entry point; `includes/`, `database/`, and `assets/` are shared code and static files, not functions themselves.

## Setup Instructions

### 1. Create a Supabase project

Go to [https://supabase.com/dashboard](https://supabase.com/dashboard), create a new project, and wait for provisioning to finish. Set and remember the database password you choose during project creation.

### 2. Get your database connection details

In the Supabase dashboard, click the **Connect** button (near the top of the project page) and pick a connection type from the dropdown — there are two you'll need, depending on where the app runs:

- **Direct connection** (good for local development): host like `db.xxxxxxxxxxxxxxxxxxxx.supabase.co`, port `5432`, user `postgres`.
- **Transaction pooler / Supavisor** (required for Vercel): a *different* hostname, like `aws-0-<region>.pooler.supabase.com`, port `6543`. The username is also different here — `postgres.<project-ref>` (e.g. `postgres.ihqfasbxscdlrpamojwv`), not plain `postgres`. Copy the exact values from the connection string shown in the "Connect" dialog's Transaction pooler tab. Serverless functions open a fresh DB connection on every invocation, so pooling avoids exhausting Postgres's connection limit under concurrent traffic.

Both share the same database name (usually `postgres`) and password (the one you set when creating the project).

### 3. Configure environment variables

Copy the example env file at the project root and fill in your real values:

```cmd
copy .env.example .env
```

Edit `.env` for **local development** (direct connection):

```
SUPABASE_DB_HOST=db.xxxxxxxxxxxxxxxxxxxx.supabase.co
SUPABASE_DB_PORT=5432
SUPABASE_DB_NAME=postgres
SUPABASE_DB_USER=postgres
SUPABASE_DB_PASSWORD=your-db-password
SUPABASE_DB_SSLMODE=require
```

`includes/db.php` loads this `.env` file automatically (no extra PHP packages needed) and falls back to real OS environment variables if you prefer to set them that way instead. **Never commit your real `.env` file** — it's already excluded via `.gitignore` and `.vercelignore`.

### 4. Create the database schema

Run `database/schema.sql` against your Supabase Postgres database. Two easy options:

**Option A — Supabase SQL Editor (web UI):**
1. Open your project in the Supabase dashboard → **SQL Editor**
2. Paste the contents of `database/schema.sql`
3. Click **Run**

**Option B — `psql` command line:**
```cmd
psql "host=db.xxxxxxxxxxxxxxxxxxxx.supabase.co port=5432 dbname=postgres user=postgres sslmode=require" -f database/schema.sql
```
(You'll be prompted for your database password.)

This creates all tables with Postgres-appropriate types (`SERIAL` primary keys, `BOOLEAN` flags, `VARCHAR` + `CHECK` constraints standing in for MySQL's `ENUM`), the `APP_SESSION` table for DB-backed sessions, plus a small set of seed data (2 sample guests, 3 sample rooms, 3 staff accounts with placeholder passwords).

### 5. Set real account passwords

The staff accounts created by `schema.sql` have placeholder (non-working) password hashes. Run the seeding script **once**, locally, to set real, hashed passwords:

```cmd
php database\seed_passwords.php
```

You should see a confirmation message listing the accounts that were updated. This file is excluded from the Vercel deployment via `.vercelignore` (it contains default plaintext passwords in its source and should never be publicly reachable) — run it locally against your Supabase DB before deploying.

### 6. Log in

With the built-in PHP dev server running from the project root:

```cmd
php -S localhost:8000
```

Go to:
```
http://localhost:8000/api/login.php
```

(Clean URLs like `/login` only apply once deployed to Vercel, which applies the routes in `vercel.json`. The PHP built-in dev server doesn't read `vercel.json`, so use the full `/api/*.php` path locally.)

## Default Login Accounts (mock credentials)

| Username      | Password         | Role              |
|---------------|------------------|-------------------|
| `ADMIN`       | `Admin#2026`     | Administrator     |
| `KDPALVARADO` | `Front#Desk2026` | Front Desk Staff  |
| `JESMEDEL`    | `Finance#2026`   | Finance Officer   |

**Change these passwords after your first login** (via the Staff page as Administrator, or by re-running/adjusting the seed script before deleting it). Do not use these defaults in any real/production deployment.

## Deploying to Vercel

This app runs on Vercel via the community-maintained [`vercel-php`](https://github.com/vercel-community/php) runtime (configured in `vercel.json`). Since Vercel's serverless PHP functions are stateless and ephemeral — a new function instance can handle any given request, with no shared disk between invocations — this app does **not** use PHP's default file-based sessions. Instead, `includes/db_session_handler.php` implements a custom `SessionHandlerInterface` backed by the `APP_SESSION` table in Postgres, so login state is shared through the same database every request already connects to.

### 1. Install the Vercel CLI and log in

```cmd
npm i -g vercel
vercel login
```

### 2. Set environment variables for the Vercel project

Use the **pooled/Supavisor** connection details (see step 2 above), not the direct connection — set these for all environments (Production, Preview, Development):

```cmd
vercel env add SUPABASE_DB_HOST
vercel env add SUPABASE_DB_PORT
vercel env add SUPABASE_DB_NAME
vercel env add SUPABASE_DB_USER
vercel env add SUPABASE_DB_PASSWORD
vercel env add SUPABASE_DB_SSLMODE
```

For `SUPABASE_DB_PORT`, enter `6543`. For `SUPABASE_DB_HOST`, enter the pooler hostname (`aws-0-<region>.pooler.supabase.com`), not the direct `db.xxxx.supabase.co` host. For `SUPABASE_DB_USER`, use the pooler-specific username (`postgres.<project-ref>`), not plain `postgres` — the transaction pooler requires this format to route the connection to the right project.

Alternatively, set these from the Vercel dashboard: **Project Settings → Environment Variables**.

### 3. Run the schema and seed script against Supabase first

Do this from your local machine *before* deploying (steps 4–5 above) — `database/seed_passwords.php` is intentionally excluded from the Vercel deployment for security, so it must be run locally.

### 4. Deploy

```cmd
vercel
```

For a production deployment:

```cmd
vercel --prod
```

### 5. Test locally with `vercel dev` (optional, requires PHP installed locally)

```cmd
vercel dev
```

This emulates the Vercel routing/runtime locally, including `vercel.json`'s clean URLs (`/login`, `/dashboard`, etc.), which the plain `php -S` dev server does not apply.

## Database Connection Config

Connection settings are read from environment variables (via `.env` locally, or `vercel env` in production) rather than hardcoded PHP constants, so real Supabase credentials never need to live in source control:

```
SUPABASE_DB_HOST=...
SUPABASE_DB_PORT=6543        # pooled/Supavisor (Vercel) — use 5432 + the direct host for local dev
SUPABASE_DB_NAME=postgres
SUPABASE_DB_USER=postgres
SUPABASE_DB_PASSWORD=your-db-password
SUPABASE_DB_SSLMODE=require
```

See `.env.example` at the project root for the full template.

## Role Permissions Summary

| Page              | Administrator | Front Desk Staff | Finance Officer |
|-------------------|:---:|:---:|:---:|
| Dashboard         | ✅ | ✅ | ✅ |
| Guests            | ✅ | ✅ | ❌ |
| Rooms             | ✅ | ✅ | ❌ |
| Reservations      | ✅ | ✅ | ❌ |
| Payments          | ✅ | ✅ | ✅ |
| Reports           | ✅ | ❌ | ✅ |
| Staff             | ✅ | ❌ | ❌ |

Unauthorized access attempts are logged to the `ACCESS_LOG` table.

## Notes

- No JSON/YAML config files are used for app logic — all configuration is plain PHP (`includes/db.php`), with secrets sourced from environment variables / `.env`.
- Room availability is enforced at the application layer with transaction locking (`SELECT ... FOR UPDATE`) to prevent double-booking race conditions.
- Payment status (`Unpaid` / `Partially Paid` / `Fully Paid` / `Refunded`) and room status (`Available` / `Reserved` / `Occupied` / `Unavailable`) update automatically based on reservation and payment activity.
- Overpayment is blocked at insert time (not just flagged after the fact): a payment that would push the reservation's total paid above its total cost is rejected with the remaining balance shown.
- Unpaid `Pending` reservations auto-expire 48 hours after creation (`expireStaleHolds()` in `includes/functions.php`), releasing the room and logging the cancellation — checked lazily on dashboard/reservations/rooms page loads rather than via an external cron job.
- Row-level ID generation uses Postgres `SERIAL` + `RETURNING` (not MySQL's `AUTO_INCREMENT` + `lastInsertId()`), and role/status fields use `VARCHAR` + `CHECK` constraints rather than native Postgres `ENUM` types, to keep PDO parameter binding simple and portable.
- PDO's pgsql driver returns lowercase column keys regardless of query casing; `includes/db.php` sets `PDO::ATTR_CASE => PDO::CASE_UPPER` so the rest of the codebase can keep using uppercase keys consistently.
- Supabase connections require TLS; the app connects with `sslmode=require` by default.
- Sessions are stored in the `APP_SESSION` table (not PHP's default file-based sessions), since Vercel's serverless PHP runtime does not guarantee a persistent, shared filesystem across invocations.
