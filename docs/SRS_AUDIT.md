# BookInn — SRS audit, decisions and assumptions

Source: `GRP 5 FINAL SRS` (revision of 29 Oct 2026, 47–49 pages). This file lists every point where the
SRS was unclear, internally inconsistent, or silent, and what the implementation does about it.
Severity: **High** = would change data or behaviour; **Medium** = affects a screen or a rule's edge case;
**Low** = wording only.

## 1. Conflicts and gaps found in the SRS

| # | Severity | Where | Issue | Resolution in the build |
|---|---|---|---|---|
| A1 | High | §1.4, §3.3 Data Retention vs. AUDIT_TRAIL | Reservations and related records must be deleted 1 year after the latest check-out and "not archived", but AUDIT_TRAIL is append-only and its INSERT/UPDATE rows contain copies of those records. | Audit rows are never deleted (the SRS makes the audit trail view-only). The retention job's own DELETE audit rows store only the record ID and the reason, not the deleted data. **Open: the group should decide whether old audit rows count as an "archive".** |
| A2 | High | §1.4 vs. FR-20 | FR-20 says payment records are maintained "for hotel record-keeping"; §1.4 deletes them after 1 year. | Implemented as §1.4 says (payments and receipts are deleted with the reservation). Suggest adding "for one (1) year after the latest check-out date" to FR-20. |
| A3 | High | §3.3 Reservation Completion | No mechanism is named for "the system automatically marks…". | Daily job `bookinn.complete_reservations(today)` run by Vercel Cron (or pg_cron), plus an administrator "Run daily maintenance now" button. Availability never depends on the job having run, because past stays cannot overlap new (non-past) bookings. |
| A4 | Medium | §2.3 "front desk staff, who have editing access to the reservation's payment details" vs. permission table (Front Desk: Create, read) | Contradiction. | The permission table wins: Front Desk records payments while booking and cannot edit them. Only the Database Administrator corrects payments (§1.4). |
| A5 | Medium | §3.3 No-Show Handling | "a notice will be sent" without a sender or channel; the status stays Booked either way. | Agreed with the group: Front Desk notifies the guest by hand. BookInn sends nothing and changes nothing. No-shows stay Booked until completion. |
| A6 | Medium | §3.3 Receipt Generation ("sent to the guest's provided email") | No email provider, sender address or failure handling is specified. | A receipt record is always created in the same transaction as the payment and can be viewed and printed. **Email sending is not implemented** (no provider configured); the receipt page says so. |
| A7 | Medium | §3.3 Room Availability vs. §3.3 Double-Booking Prevention | Both bullets describe the same rule. | One rule: only `Booked` reservations block a room, using half-open intervals `[check-in, check-out)`. |
| A8 | Medium | Permission table "Customer, loyalty account — Front Desk: Create, read, update" | Letting Front Desk type a point balance would bypass the loyalty rules. | Front Desk can open loyalty accounts (start at 0 points). `TOTAL_PTS` changes only through recorded payments, or through an administrator correction. |
| A9 | Medium | §1.4 "no further edits … apart from the booking status" | The SRS does not say who may change the status other than cancelling. | Front Desk changes the status only by cancelling. The system sets Completed. The administrator may correct status (Booked ↔ Completed); reinstating a cancellation is done by the administrator deleting the cancellation record, and is refused if the rooms have been rebooked. |
| A10 | Medium | Loyalty "points earned = total payment amount ÷ 50" | "Total payment amount" could mean before or after discount. | Moot in practice: a payment that uses a discount earns no points (cannot earn and spend in one transaction), so points are always earned on `PAY_AMT`, which equals the undiscounted total. |
| A11 | Medium | Loyalty earning without an account | The SRS does not say whether guests without a loyalty account earn points. | Points are earned only if the guest already has a loyalty account when the payment is recorded; `PTS_EARN` is 0 otherwise. |
| A12 | Medium | 12% discount rounding | Not specified when 12% produces fractions of a centavo. | 12% is rounded half-up to the centavo, then subtracted. |
| A13 | Medium | Free Night | "Most expensive room booked" with multiple rooms at the same price; amount could go below 0. | One night of the highest nightly price among the booked rooms is deducted, never below ₱0.00. |
| A14 | Medium | "Bookings cannot start in the past" | No time zone given. | Dates are judged in the hotel's time zone, Asia/Manila. Check-in today is allowed. The rule applies to new bookings, not to administrator corrections. |
| A15 | Low | STAFF.IS_ACTIVE enum Yes/No | The earlier build used a boolean. | Converted to an enum with values `Yes`, `No` as in the data dictionary. |
| A16 | Low | CANCELLATION.CANCELLED_BY removed | Earlier build had the column. | Dropped. The sample audit row that mentions `CANCELLED_BY=Customer` is seeded as `RES_ID=1003; CANCEL_DATE=2026-09-15`. |
| A17 | Low | Sample audit row 1001 is by staff 1002 (Finance) updating LOYALTY_ACC | Finance is read-only in the revised SRS. | Seeded with staff 1001 (Front Desk). |
| A18 | Low | ROOM_DETAILS.ROOM_PRICE "Cannot be negative" | A ₱0 room would make the free-night rule meaningless. | Kept the stricter existing rule `ROOM_PRICE > 0`. |
| A19 | Low | Figures 2–3, §2.3, §3.2 | Still mention online booking, guests using the system, "on hold" status and Finance updating payments. | Not built. Text and figures should be updated by the group (see §4 below). |
| A20 | Low | §5–§8, User Manual, Appendices | Empty template sections; §6 has no screen designs. | Screens designed from the functional requirements. |
| A21 | Low | Sample data (item 11, deferred by the group) | Mixed date formats; reservations 1001 and 1002 still "Booked" after their stays; 3NF loyalty 5001 = 120 vs 240; placeholder passwords; no administrator. | Seed uses ISO dates, marks finished stays Completed, 5001 = 240 points before the extra demo booking, real bcrypt hashes, and adds an `ADMIN` account. |

## 2. Implementation decisions (no SRS change)

- **Authentication**: server-side login against `STAFF.U_NAME`/`STAFF.PASS` (bcrypt, cost 12) with a signed,
  HttpOnly session cookie. Supabase Auth was not used, because the SRS stores credentials in STAFF and
  replacing them with `auth.users` would change the schema. The staff row is re-read on every request, so
  deactivation and role changes apply immediately.
- **Database access**: only the Next.js server talks to Postgres (no Supabase client keys in the browser).
  Row Level Security is **enabled on all 11 tables with no policies for `anon`/`authenticated`**, and those
  roles have no privileges on schema `bookinn`, so the Supabase Data API cannot read or write BookInn data
  even if the schema is later exposed. Role-based permissions are enforced by the server and by database
  triggers and constraints.
- **Audit trail**: written by database triggers on all 10 audited tables, so changes are recorded even if they
  bypass the app. The server stores the acting staff ID in the transaction setting `bookinn.staff_id`;
  rows with `STAFF_ID = NULL` are system actions (daily jobs, seeding). Password hashes are never logged.
- **Double booking**: checked by the server for a friendly message, and enforced by a database trigger that
  locks the room row (`SELECT … FOR UPDATE`) so concurrent bookings of the same room are serialised.
- **Reservation + payment** are written in one transaction (reservation, reserved rooms, payment, receipt,
  loyalty balance). If any step fails, nothing is saved, so a reservation can never exist unpaid.
- **Amount due** is computed by the server from `ROOM_DETAILS.ROOM_PRICE × nights`. The browser's total is
  never trusted.
- **Colour contrast**: white text on `#3AA358` is 3.2:1 and on `#208A46` 4.4:1, both below WCAG AA (4.5:1).
  Primary buttons therefore use `#026E2F` (6.4:1) with `#004318` on hover; `#3AA358` is used for focus rings,
  the active navigation marker, highlights and borders.

## 3. Permission matrix as implemented

| Data | Front Desk | Finance | Database Administrator |
|---|---|---|---|
| Customer | Create, read, update | Read | All (delete only without dependents) |
| Loyalty account | Create (0 pts), read | Read | All, including point corrections |
| Room, room type | Read | Read | All |
| Reservation, reserved rooms | Create (booking form), read, cancel | Read | All (corrections are audited) |
| Payment, receipt | Create (booking form), read | Read | All (corrections are audited) |
| Cancellation | Create, read | Read | All |
| Staff | Own name and password only | Own name and password only | All |
| Audit trail | — | — | Read only |

## 4. Suggested SRS text edits (cosmetic, not blocking)

1. §2.3 "who have editing access to the reservation's payment details" → "who log the reservation's payment details".
2. §2.3 "all employees and guests see the reflected update" → "all employees see the reflected update".
3. §3.2 "front desk staff, guests, and finance officers" → "front desk staff and finance officers".
4. §3.3 No-Show Handling → "front desk staff may notify the guest through their provided email or mobile number".
5. Figures 2 and 3: remove online booking and the "on hold" branch; Front Desk enters the payment.
6. FR-20: add "for one (1) year after the reservation's latest check-out date".
