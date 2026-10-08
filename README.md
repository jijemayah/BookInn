# BookInn — Hotel Reservation System

A simple hotel reservation management system built with **PHP + MySQL**, running on **XAMPP (Apache + MySQL)**. 

## Features

- Guest management
- Room & room type management (with maintenance lock)
- Reservations with overlap/double-booking prevention
- Payments with auto receipt generation and payment status tracking
- Role-based access control (Administrator, Front Desk Staff, Finance Officer)
- Reports (Admin / Finance Officer only)
- Audit logging (access attempts + cancellations)

## Requirements

- **XAMPP** (includes Apache, MySQL, PHP) — [https://www.apachefriends.org/](https://www.apachefriends.org/)
  - PHP 8.x (tested on PHP 8.2)
  - MySQL / MariaDB
- A web browser
- (Optional) VS Code with the **SQLTools** + **SQLTools MySQL/MariaDB/TiDB** extensions, if you want to run SQL directly from the editor

## Project Structure

```
app/
├── assets/
│   └── style.css
├── database/
│   ├── schema.sql            # Run this first to create the database + tables
│   └── seed_passwords.php    # Run once to set default account passwords
├── includes/
│   ├── db.php                # Database connection settings (edit if needed)
│   ├── auth.php              # Login/session/RBAC logic
│   ├── functions.php         # Business rules (overlap check, status sync, etc.)
│   ├── header.php
│   └── footer.php
├── index.php
├── login.php
├── logout.php
├── dashboard.php
├── customers.php             # Guest management
├── rooms.php                 # Room & room type management
├── reservations.php
├── payments.php
├── staff.php                 # Admin only
└── reports.php                # Admin / Finance Officer only
```

## Setup Instructions

### 1. Install XAMPP

Download and install XAMPP if you haven't already: [https://www.apachefriends.org/](https://www.apachefriends.org/)

### 2. Place the project in `htdocs`

Copy (or symlink/junction) the `app` folder into your XAMPP `htdocs` directory, so it's reachable by Apache:

```
C:\xampp\htdocs\bookinn\   <-- should contain login.php, dashboard.php, etc.
```

If you'd rather keep the project files elsewhere (e.g. in your own working folder) and just link it into `htdocs`, you can create a **junction** on Windows (no admin rights required, unlike symlinks):

```cmd
mklink /J "C:\xampp\htdocs\bookinn" "C:\path\to\your\project\app"
```

### 3. Start Apache and MySQL

Open the **XAMPP Control Panel** and click **Start** next to both **Apache** and **MySQL**.

> **Port note:** If port 80 is already used by another program on your machine (common on Windows, e.g. IIS or another web server), Apache will run on **port 8080** instead. Check the XAMPP Control Panel — the port number is shown next to the Apache module once it's running. All URLs below assume port `8080`; adjust if yours differs (e.g. plain `http://localhost/bookinn/...` if you're on port 80).

### 4. Create the database

Import the schema using phpMyAdmin **or** the command line.

**Option A — phpMyAdmin:**
1. Go to `http://localhost:8080/phpmyadmin`
2. Click **Import**, choose `app/database/schema.sql`, click **Go**

**Option B — command line:**
```cmd
"C:\xampp\mysql\bin\mysql.exe" -h 127.0.0.1 -u root --execute="source C:/xampp/htdocs/bookinn/database/schema.sql"
```

This creates the `bookinn` database with all tables and a small set of seed data (2 sample guests, 3 sample rooms, 3 staff accounts with placeholder passwords).

### 5. Set real account passwords

The staff accounts created by `schema.sql` have placeholder (non-working) password hashes. Run the seeding script **once** to set real, hashed passwords:

Visit in your browser:
```
http://localhost:8080/bookinn/database/seed_passwords.php
```

You should see a confirmation message listing the accounts that were updated.

**⚠️ Important:** After confirming login works, delete this file (or block access to it) — it contains default plaintext passwords in its source code and should not stay publicly reachable, especially if this project is pushed to GitHub.

```cmd
del "C:\xampp\htdocs\bookinn\database\seed_passwords.php"
```

### 6. Log in

Go to:
```
http://localhost:8080/bookinn/login.php
```

## Default Login Accounts (mock credentials)

| Username      | Password         | Role              |
|---------------|------------------|-------------------|
| `ADMIN`       | `Admin#2026`     | Administrator     |
| `KDPALVARADO` | `Front#Desk2026` | Front Desk Staff  |
| `JESMEDEL`    | `Finance#2026`   | Finance Officer   |

**Change these passwords after your first login** (via the Staff page as Administrator, or by re-running/adjusting the seed script before deleting it). Do not use these defaults in any real/production deployment.

## Database Connection Config

Connection settings are in `includes/db.php` (plain PHP constants, no JSON/YAML):

```php
define('DB_HOST', '127.0.0.1');
define('DB_PORT', '3306');
define('DB_NAME', 'bookinn');
define('DB_USER', 'root');
define('DB_PASS', '');   // default XAMPP root password is empty
```

Edit these values if your MySQL setup uses a different host, port, username, or password.

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

- No JSON/YAML config files are used anywhere — all configuration is plain PHP (`includes/db.php`).
- Room availability is enforced at the application layer with transaction locking to prevent double-booking race conditions.
- Payment status (`Unpaid` / `Partially Paid` / `Fully Paid` / `Refunded`) and room status (`Available` / `Reserved` / `Occupied` / `Unavailable`) update automatically based on reservation and payment activity.
