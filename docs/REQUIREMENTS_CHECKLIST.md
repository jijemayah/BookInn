# BookInn — requirements checklist

Maps every SRS functional requirement and business rule to where it is implemented and how it is tested.
Test files are in `tests/`; the numbers (#1–#25) are the acceptance cases from the implementation brief.
"Smoke" = the HTTP + browser check of the production build described in the README.

## Functional requirements

| ID | Requirement | Implementation | Verified by |
|---|---|---|---|
| FR-01 | Staff log in and out | `lib/staff-auth.ts` (bcrypt), `lib/session.ts` (signed HttpOnly cookie), `app/login` | `rbac.test.ts` #18; smoke (wrong password, sign-in) |
| FR-02 | Create, update, deactivate accounts | Staff screens (administrator only), `STAFF.IS_ACTIVE` Yes/No | `crud.test.ts` STAFF; `rbac.test.ts` #18 |
| FR-03 | Users manage their own account | Account settings: own name and password | `rbac.test.ts` "lets staff manage their own account" |
| FR-04 | Administrators assign roles | Staff form `ROLE`; lock-out guard | `rbac.test.ts` "prevents an administrator from locking everyone out" |
| FR-05 | Enforce the permissions defined for each role | `ENTITIES[*].perms` (SRS permission table), `assertCan` on every operation | `rbac.test.ts` #19 |
| FR-06 | Restrict features and data by role | Server checks in `crud.ts`/`booking.ts`; role-aware navigation | `rbac.test.ts` #19, #20; smoke (Finance refused on /book, /staff) |
| FR-07 | Add and update guest information | Customers (Front Desk, administrator) | `crud.test.ts` CUSTOMER |
| FR-08 | Search and view guest records | List search, filters, sort, pagination; customer detail | `crud.test.ts` "list pages"; smoke |
| FR-09 | Guest linked to reservations | `RESERVATION.CUS_ID` FK; customer page lists reservations and loyalty account | smoke `/customer/1001` |
| FR-10 | Open a loyalty account; points accumulate/spend with payments | Loyalty accounts (start at 0); `booking.ts` updates `TOTAL_PTS` in the payment transaction | `booking.test.ts` #12–#17 |
| FR-11 | Add and update rooms | Rooms and room types (administrator, per the permission table) | `crud.test.ts` ROOM_DETAILS and ROOM |
| FR-12 | Display room availability | Dashboard availability check, `lib/dashboard.ts` | `jobs.test.ts` #25 |
| FR-13 | Create reservations | New booking form (`/book`), `createBooking` | `booking.test.ts` #1 |
| FR-14 | View and cancel reservations | Reservation detail; Cancel button (Front Desk); no edits after logging | `booking.test.ts` #7, #17, #21; smoke (cancel in browser) |
| FR-15 | Check availability while booking | Review step prices and checks every room | `booking.test.ts` #5 |
| FR-16 | Prevent duplicate bookings | Server check + DB trigger with room row lock | `booking.test.ts` #5, #6, #6b |
| FR-17 | Accurate reservation records | Constraints, single-transaction booking, audit trail | `schema.test.ts`, `booking.test.ts` #9 |
| FR-18 | Record payment information | Payment written with the booking; receipt generated | `booking.test.ts` #1, #11 |
| FR-19 | View and log payment records | Front Desk logs (booking form), Finance views, administrator corrects | `rbac.test.ts` #19; `booking.test.ts` #21 |
| FR-20 | Maintain payment records | Kept until the 1-year retention deletion (see SRS_AUDIT A2) | `jobs.test.ts` #23 |

## Business rules (§3.3)

| Rule | Implementation | Verified by |
|---|---|---|
| Unique username, one role | `staff_u_name_uq`, case-insensitive `staff_u_name_lower_uq`, `ROLE` enum | `rbac.test.ts` "unique usernames" |
| Only administrators manage accounts; view-only audit trail; no deleting records with dependents | `perms`, delete guard + `ON DELETE RESTRICT`, append-only trigger | `rbac.test.ts` #19, "refuses to delete"; `schema.test.ts` |
| Deactivated accounts cannot log in; history kept | `is_active = 'Yes'` checked at login and on every request | `rbac.test.ts` #18 |
| Unauthorized attempts blocked | `AppError("forbidden")` on the server; RLS for the Data API | `rbac.test.ts` #19, #20; `schema.test.ts` RLS |
| Password policy, hashed storage | `isStrongPassword`, bcrypt cost 12, `pass` CHECK for bcrypt format | `rbac.test.ts` "password policy" |
| Guest needs name, email, mobile; unique email | NOT NULL + CHECKs, `customer_email_uq` | `crud.test.ts` "duplicate emails" |
| Guest profiles and loyalty accounts kept permanently | Retention job never touches them; customers with dependents cannot be deleted | `jobs.test.ts` #23 |
| Reservations and related records deleted 1 year after latest check-out | `bookinn.purge_expired_reservations()` via daily maintenance | `jobs.test.ts` #23 (idempotent, logged) |
| Room needs number, type, view, price | PK/FK/NOT NULL, `room_price > 0` | `schema.test.ts` |
| Double booking: only Booked reservations block | `assert_room_free` trigger, half-open `[in, out)` | `booking.test.ts` #5–#8; `jobs.test.ts` #25 |
| Booking needs a verified guest, room(s), valid dates, not in the past | `booking.ts` validation (Asia/Manila date) | `booking.test.ts` #2–#4 |
| Payment settled immediately, once, in full | Reservation + payment + receipt in one transaction; `payment_res_uq`; exact-amount check | `booking.test.ts` #9, #10 |
| Completed the day after the latest check-out | `bookinn.complete_reservations()` | `jobs.test.ts` "Reservation Completion" |
| Cancellations: no fee, no refund; Front Desk cancels | `cancelReservation`; payment and points untouched | `booking.test.ts` #17 |
| No-show stays Booked until check-out passes | No automatic cancellation; completion job handles it | `jobs.test.ts` (completion) |
| Every payment attaches to one reservation | `payment.res_id` FK + unique | `booking.test.ts` #10 |
| Payment must equal the amount due | Server-computed due amount; browser total never trusted | `booking.test.ts` #9 |
| Traceable receipt per payment | Receipt created in the same transaction; `receipt_pay_uq` | `booking.test.ts` #11, #16 |
| Receipt emailed to the guest | **Not implemented** (no email provider configured); printable receipt page | — (see SRS_AUDIT A6) |
| Points only when payment is logged | Points change only inside the payment transaction | `booking.test.ts` #1, #12 |
| Points = payment ÷ 50, decimals dropped | `pointsEarned` | `booking.test.ts` #12 |
| Cannot earn and spend at once | `pointsFor` + `payment_earn_xor_spend_chk` | `booking.test.ts` #13 |
| Points final after cancellation | Cancellation does not touch points | `booking.test.ts` #17 |
| One discount; 100 pts = 12%, 250 pts = free night | `discount_type` enum + `payment_discount_pts_chk` | `booking.test.ts` #14, #15 |
| 12% of total deducted; free night = one night of the most expensive room; ₱0 allowed | `amountDue` | `booking.test.ts` #15, #16 |
| Logged reservations not editable; administrator corrects, audited | `perms` (Front Desk has no update), audit triggers | `booking.test.ts` #21 |
| Audit trail of changes | Triggers on all 10 tables; `STAFF_ID` NULL for system actions | `crud.test.ts` #22; `schema.test.ts` |

## Acceptance cases from the brief

| # | Case | Test |
|---|---|---|
| 1 | Valid reservation persisted | `booking.test.ts` |
| 2 | Missing customer rejected | `booking.test.ts` |
| 3 | Check-out on/before check-in rejected | `booking.test.ts` |
| 4 | Start in the past rejected | `booking.test.ts` |
| 5 | Overlapping booking rejected | `booking.test.ts` |
| 6 | Simultaneous conflicting bookings | `booking.test.ts` (+ 6b DB-level) |
| 7 | Cancellation releases dates | `booking.test.ts` |
| 8 | Completed does not block | `booking.test.ts` |
| 9 | Wrong amount rejected | `booking.test.ts` |
| 10 | Duplicate payment rejected | `booking.test.ts` |
| 11 | Receipt linked to one payment | `booking.test.ts` |
| 12 | Points calculation | `booking.test.ts` |
| 13 | No earn + spend together | `booking.test.ts` |
| 14 | Insufficient points | `booking.test.ts` |
| 15 | 12% and free-night totals | `booking.test.ts` |
| 16 | ₱0 free-night payment | `booking.test.ts` |
| 17 | Cancellation: no refund, points kept | `booking.test.ts` |
| 18 | Deactivated account blocked | `rbac.test.ts` |
| 19 | Role permissions | `rbac.test.ts` |
| 20 | Unauthorized endpoint access | `rbac.test.ts` (cron endpoint), smoke |
| 21 | No edits after confirmation | `booking.test.ts` |
| 22 | Audit entries created | `crud.test.ts`, `schema.test.ts` |
| 23 | Retention job | `jobs.test.ts` |
| 24 | CRUD persists | `crud.test.ts` |
| 25 | Dashboard and availability match the DB | `jobs.test.ts` |

## Not done or blocked by external setup

| Item | Status |
|---|---|
| Receipt and no-show emails | Not implemented: needs an email provider. No-show notices are sent by Front Desk by hand (agreed). |
| Scheduled maintenance on Vercel | Code and `vercel.json` cron are ready; needs `CRON_SECRET` in Vercel and a deploy before it runs. Not verified on Vercel. |
| Migration 0003 on Supabase | Not applied yet; tested on a copy of the old schema (`upgrade.test.ts`). |
| Supabase Auth | Not used; see SRS_AUDIT §2 (credentials stay in `STAFF`). |
