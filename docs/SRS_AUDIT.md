# BookInn — SRS audit, decisions and assumptions

Source of truth: **SRS v2 (November 2026), Sections 1–4**, transcribed in [`docs/SRS_v2.md`](SRS_v2.md). Sections 5 onward
are empty in the SRS and are not used. The SRS text is **not** changed by the implementation: this file records how the
build handles points the SRS leaves open, and the implementation decisions behind it.

## 1. Where the SRS is silent: decisions (B) and seed data (S)

| # | Where the SRS is silent | Decision |
|---|---|---|
| B1 | Existing rows recorded under the old rules | Migration 0005: Booked reservations whose latest check-out has passed become Completed (not No-Show, so no notices for old data). Still-Booked reservations: points credited at payment are taken back (never below 0) and `PTS_EARN` is recalculated as amount ÷ 100, credited at Completed. Every existing payment becomes `PAY_TYPE = Initial`. Old cancellations get no refund rows. |
| B2 | No-Show with an Unpaid charge | The daily job voids it ("Voided when cancelled or unused"), so the reservation leaves the overdue list and can be purged. |
| B3 | "A Checked-In room stays unavailable until it is checked out" | A checked-in room past its check-out date blocks bookings through today; later dates stay bookable. |
| B4 | "Users cannot delete records that other records depend on" vs. the cascades of Table 20 | The cascades exist; a trigger refuses any delete of a reservation, reserved room or payment that still has dependents, except during the retention purge. |
| B5 | `ROOM_PRICE` "cannot be negative" | `room_price >= 0` (₱0 allowed). The price is read-only on the edit form and a trigger refuses any change. |
| B6 | Status rules | Checked-In needs a checked-in room; Cancelled and No-Show need none; Completed needs no room checked in, none still expected (a never-checked-in room counts until its check-out date has passed) and no Unpaid charge. Earned points are credited by a trigger when a reservation becomes Completed (and taken back if an administrator moves it out of Completed). |
| B7 | Checkout Credit refunds per reservation | At most one, like the single Checkout payment. |
| B8 | Extension amount | Checked on insert: nights × `ROOM_PRICE` of that room. |
| B9 | ₱0 refund (the Initial payment was a free night) | An on-time cancellation still records a ₱0 Cancellation refund and sends its confirmation. |
| B10 | Modification cutoff when the edit moves the earliest check-in earlier | Both the original and the new earliest check-in must be at least 48 hours away (14:00 rule). A reservation keeps at least one room. Unchanged rows are not re-priced; one Modification charge per edit. |
| B11 | Early departure on the check-in day | The check-out date keeps at least one night. A partly used extension is voided and the used nights are posted again as a new Extension charge. |
| B12 | Checkout payment timing | Taken at the check-out that leaves no room checked in (SRS wording). Check-out is recorded first and the bill settled right after on the same page; until then the reservation stays Checked-In with Unpaid charges (and becomes overdue after its latest check-out). After the settlement no new charges (extensions) can be added. Charges that add up to exactly ₱0 are marked Paid with no payment or refund row. |
| B13 | Extension into another room | Added as a new reserved-room row from the current check-out date (not in the past); Front Desk checks that row in when the guest moves. |
| B14 | Late check-out | No extra charge; the room stays blocked until it is checked out and the reservation shows as overdue. |
| B15 | Cancellation via the generic Cancellations form | Runs the same refund and points rules as the Cancel button, judged at the current time. Reinstating (administrator deletes the cancellation) requires deleting its Cancellation refund first and deducts the returned spent points again. |
| B16 | Checkout payment points | A Checkout payment earns amount ÷ 100 (SRS sample payment 1004 earns 15), credited at Completed; a Checkout Credit earns nothing. |
| B17 | Table 2 "Customer, loyalty account — Front Desk: update" | Front Desk opens loyalty accounts (0 points) and reads them; it cannot type a point balance. `TOTAL_PTS` changes only through payments, cancellations and Completed, or an administrator correction. |
| B18 | "the Database Administrator can add more room types and views" (Table 26) while the columns are enums | They stay Postgres enums. The administrator adds values on the Room types page (*Add a room type name or room view*); forms and filters read the current values from the database. Values cannot be removed or renamed. Adding a value is a schema change, so it does not appear in the audit trail. |
| B19 | Email sender and failures (§1.4: "sent by email through Resend") | `RESEND_API_KEY` and `RESEND_FROM_EMAIL` from the environment; without them emails are skipped and logged. Emails are sent after the transaction commits; a failure is logged and never undoes or stops the booking, payment, refund or daily job. Each email has an idempotency key. |
| B20 | Daily job time zone (00:05 Asia/Manila) | Vercel Cron runs in UTC: `"5 16 * * *"` = 00:05 Manila (UTC+8, no daylight saving time). |
| B21 | Generic forms for charges and refunds | Front Desk works on charges and refunds through the reservation page (edit, extend, check-out, settle, cancel). The generic Charges and Refunds forms are for administrator corrections; Finance only reads them. |
| S1–S4 | Seed data | SRS Tables 7–19 as written, ISO dates, real bcrypt hashes; README test accounts kept (JESMEDEL active although the SRS sample shows `IS_ACTIVE = No`, plus `ADMIN` and `ETEGGERE`); demo reservation 1004 (room 206, Dec 20–22, payment 1005) for an upcoming stay. See `src/lib/db/seed.ts`. |

Open points for the group (no code change needed):

1. **Audit rows vs. "not archived".** Retention deletes reservations, but the audit trail is append-only and permanent (SRS
   §1.4), so older INSERT/UPDATE audit rows still contain copies of the deleted data. The purge's own DELETE rows store only
   the record ID and a "RETENTION" note.
2. **Sample guests' emails** look like real Gmail addresses. Change them before Resend is configured.

## 2. Implementation decisions (no SRS change)

- **Authentication**: server-side login against `STAFF.U_NAME`/`STAFF.PASS` (bcrypt, cost 12) with a signed, HttpOnly
  session cookie. Supabase Auth is not used (SRS §1.4: the password is stored only as a hash in STAFF). The staff row is
  re-read on every request, so deactivation and role changes apply immediately.
- **Database access**: only the Next.js server talks to Postgres (no Supabase client keys in the browser). Row Level Security
  is **enabled on all 13 tables with no policies for `anon`/`authenticated`**, and those roles have no privileges on schema
  `bookinn` (including the overdue view), so the Supabase Data API cannot read or write BookInn data.
- **Audit trail**: written by database triggers on all 12 audited tables, so changes are recorded even if they bypass the
  app. The server stores the acting staff ID in the transaction setting `bookinn.staff_id`; rows with `STAFF_ID = NULL` are
  system actions (daily job, points credited at Completed, conversions). Password hashes are never logged.
- **Hotel time**: all dates and times are Asia/Manila. The server tells each transaction which hotel day it acts on
  (`bookinn.today`), so database triggers and application rules agree on "today".
- **Double booking**: checked by the server for a friendly message (it calls the same database function), and enforced by a
  trigger that locks the room row so concurrent bookings of the same room are serialised.
- **Amounts** are computed by the server from `ROOM_DETAILS.ROOM_PRICE × nights`; the browser's total is never trusted, and
  every payment must equal the amount due (discounted total for Initial, sum of Unpaid charges for Checkout).
- **Single transactions**: booking + Initial payment + receipt + spent points; cancellation + refund + voided charges +
  returned points + status; settlement + Checkout payment (or credit) + receipt + charges Paid + Completed. If any step
  fails, nothing is saved.
- **Colour contrast**: primary buttons use `#026E2F` (6.4:1 with white text); `#3AA358` is used only for focus rings,
  markers and borders.

## 3. Permission matrix as implemented (SRS v2 Table 2)

| Data | Front Desk | Finance | Database Administrator |
|---|---|---|---|
| Customer | Create, read, update | Read | All (delete only without dependents) |
| Loyalty account | Create (0 pts), read (see B17) | Read | All, including point corrections |
| Room, room type | Read | Read | All except editing `ROOM_PRICE`; adds room type names and views |
| Reservation, reserved rooms | Book, read, edit (Booked, before the cutoff), cancel, check in, check out, extend | Read | All (corrections are audited) |
| Payment, receipt | Create (Initial at booking, Checkout at settlement), read | Read | All (corrections are audited) |
| Charge | Create (edit, extension), settle or void (check-out, cancellation), read | Read | All |
| Refund | Create (cancellation, Checkout Credit), read | Read | All |
| Cancellation | Create, read | Read | All |
| Overdue list | — | Read | Read |
| Staff | Own name and password only | Own name and password only | All |
| Audit trail | — | — | Read only |

## 4. Superseded decisions of the 29 Oct 2026 revision

The earlier build followed the previous SRS revision. These behaviours were **replaced** by SRS v2:

| Before | Now (SRS v2) |
|---|---|
| One payment per reservation; points = amount ÷ 50, credited at payment | One Initial and at most one Checkout payment; points = amount ÷ 100, credited at Completed |
| Cancellation: no refund, points kept | 100% refund at least 48 h before the earliest check-in at 14:00; spent points returned; earned points never credited |
| Statuses Booked, Completed, Cancelled; daily job marked stays Completed by date | Booked, Checked-In, Completed, Cancelled, No-Show; check-in/out events per room; daily job: No-Show → Completed → purge |
| No edits after booking (administrator corrections only) | Front Desk edits Booked reservations until the cutoff (Modification charges) and extends stays (Extension charges) |
| No-shows stayed Booked; Front Desk notified guests by hand | The daily job sets No-Show and emails the guest |
| Receipt emails not implemented | Receipts, refund confirmations and No-Show notices through Resend |
| All foreign keys `ON DELETE RESTRICT` | Table 20 cascades from RESERVATION and PAYMENT, guarded so that only the purge uses them (B4) |
| `ROOM_PRICE > 0`, editable by the administrator | `ROOM_PRICE >= 0`, fixed when the room type is created (B5) |
