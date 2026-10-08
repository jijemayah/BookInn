# BookInn — Hotel Reservation System

A simple hotel reservation management system built with **PHP + PostgreSQL**, using **Supabase** as the managed Postgres database host.

## Features

- Guest management
- Room & room type management (with maintenance lock)
- Reservations with overlap/double-booking prevention
- Payments with auto receipt generation and payment status tracking
- Role-based access control (Administrator, Front Desk Staff, Finance Officer)
- Reports (Admin / Finance Officer only)
- Audit logging (access attempts + cancellations)

## Requirements

- **PHP 8.x** (tested on PHP 8.2) with the **`pdo_pgsql`** extension enabled
  - On Windows, uncomment `extension=pdo_pgsql` in `php.ini`
  - A local web server for PHP (e.g. `php -S localhost:8000` from the project root, or Apache/Nginx + PHP-FPM)
- A **Supabase** project (free tier is enough) — [https://supabase.com/](https://supabase.com/)
  - You only need the project's Postgres **database connection string / parameters**, not the JS client libraries, since this app talks to Postgres directly over PDO.
- A web browser
- (Optional) VS Code with the **SQLTools** + **SQLTools PostgreSQL/CockroachDB** extensions, if you want to run SQL directly from the editor

## Project Structure

```
.env.example                  # Template for Supabase DB credentials (copy to .env)
assets/
└── style.css
database/
├── schema.sql                # Run this first to create tables in your Supabase DB
└── seed_passwords.php        # Run once to set default account passwords
includes/
├── db.php                    # Database connection (reads Supabase creds from .env / env vars)
├── auth.php                  # Login/session/RBAC logic
├── functions.php             # Business rules (overlap check, status sync, etc.)
├── header.php
└── footer.php
index.php
login.php
logout.php
dashboard.php
customers.php                 # Guest management
rooms.php                     # Room & room type management
reservations.php
payments.php
staff.php                     # Admin only
reports.php                   # Admin / Finance Officer only
```

## Setup Instructions

### 1. Create a Supabase project

Go to [https://supabase.com/dashboard](https://supabase.com/dashboard), create a new project, and wait for provisioning to finish. Set and remember the database password you choose during project creation.

### 2. Get your database connection details

In the Supabase dashboard: **Project Settings → Database → Connection parameters**. You'll need:

- Host (e.g. `db.xxxxxxxxxxxxxxxxxxxx.supabase.co`)
- Port (`5432` for a direct connection, or `6543` for the pooled/PgBouncer connection)
- Database name (usually `postgres`)
- User (usually `postgres`)
- Password (the one you set when creating the project)

### 3. Configure environment variables

Copy the example env file at the project root and fill in your real values:

```cmd
copy .env.example .env
```

Edit `.env`:

```
SUPABASE_DB_HOST=db.xxxxxxxxxxxxxxxxxxxx.supabase.co
SUPABASE_DB_PORT=5432
SUPABASE_DB_NAME=postgres
SUPABASE_DB_USER=postgres
SUPABASE_DB_PASSWORD=your-db-password
SUPABASE_DB_SSLMODE=require
```

`includes/db.php` loads this `.env` file automatically (no extra PHP packages needed) and falls back to real OS environment variables if you prefer to set them that way instead (e.g. in your hosting platform's config). **Never commit your real `.env` file** — it's already excluded via `.gitignore`.

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

This creates all tables with Postgres-appropriate types (`SERIAL` primary keys, `BOOLEAN` flags, `VARCHAR` + `CHECK` constraints standing in for MySQL's `ENUM`) plus a small set of seed data (2 sample guests, 3 sample rooms, 3 staff accounts with placeholder passwords).

### 5. Set real account passwords

The staff accounts created by `schema.sql` have placeholder (non-working) password hashes. Run the seeding script **once** to set real, hashed passwords. With the built-in PHP dev server running from the project root:

```cmd
php -S localhost:8000
```

Then visit in your browser:
```
http://localhost:8000/database/seed_passwords.php
```

You should see a confirmation message listing the accounts that were updated.

**⚠️ Important:** After confirming login works, delete this file (or block access to it) — it contains default plaintext passwords in its source code and should not stay publicly reachable, especially if this project is pushed to a public repository.

```cmd
del database\seed_passwords.php
```

### 6. Log in

Go to:
```
http://localhost:8000/login.php
```

## Default Login Accounts (mock credentials)

| Username      | Password         | Role              |
|---------------|------------------|-------------------|
| `ADMIN`       | `Admin#2026`     | Administrator     |
| `KDPALVARADO` | `Front#Desk2026` | Front Desk Staff  |
| `JESMEDEL`    | `Finance#2026`   | Finance Officer   |

**Change these passwords after your first login** (via the Staff page as Administrator, or by re-running/adjusting the seed script before deleting it). Do not use these defaults in any real/production deployment.

## Database Connection Config

Connection settings are read from environment variables (via `.env`, loaded by `includes/db.php`) rather than hardcoded PHP constants, so real Supabase credentials never need to live in source control:

```
SUPABASE_DB_HOST=db.xxxxxxxxxxxxxxxxxxxx.supabase.co
SUPABASE_DB_PORT=5432
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
- Row-level ID generation uses Postgres `SERIAL` + `RETURNING` (not MySQL's `AUTO_INCREMENT` + `lastInsertId()`), and role/status fields use `VARCHAR` + `CHECK` constraints rather than native Postgres `ENUM` types, to keep PDO parameter binding simple and portable.
- Supabase connections require TLS; the app connects with `sslmode=require` by default.
