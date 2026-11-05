# BookInn — requirements checklist (SRS v2)

Maps every SRS v2 functional requirement and business rule ([`docs/SRS_v2.md`](SRS_v2.md)) to where it is implemented and
how it is tested. Test files are in `tests/`. Decisions where the SRS is silent are numbered B1–B21 in
[`docs/SRS_AUDIT.md`](SRS_AUDIT.md).

## Functional requirements

| ID | Requirement | Implementation | Verified by |
|---|---|---|---|
| FR-01 | Staff log in and out | `lib/staff-auth.ts` (bcrypt), `lib/session.ts` (signed HttpOnly cookie), `app/login` | `rbac.test.ts` |
| FR-02 | Create, update, deactivate accounts | Staff screens (administrator only), `STAFF.IS_ACTIVE` Yes/No | `crud.test.ts` STAFF; `rbac.test.ts` |
| FR-03 | Users manage their own account | Account settings: own name and password | `rbac.test.ts` "manage their own account" |
| FR-04 | Administrators assign roles | Staff form `ROLE`; lock-out guard | `rbac.test.ts` "locking everyone out" |
| FR-05 | Enforce role permissions | `ENTITIES[*].perms`, `assertCan`, `assertFrontDesk`, `canViewOverdue` | `rbac.test.ts`, `stay.test.ts` permissions, `screens.test.ts` |
| FR-06 | Restrict features and data by role | Server checks in every library function; role-aware navigation and reservation page | `rbac.test.ts`, `screens.test.ts` |
| FR-07 | Add and update guest information | Customers (Front Desk, administrator) | `crud.test.ts` CUSTOMER |
| FR-08 | Search and view guest records | List search, filters, sort, pagination; customer detail | `crud.test.ts` "list pages" |
| FR-09 | Guest linked to reservations | `RESERVATION.CUS_ID`; customer page lists reservations and loyalty account | `schema.test.ts` |
| FR-10 | Loyalty accounts accumulate and spend points | Loyalty accounts (start at 0); points through payments and Completed | `stay.test.ts` 1001/1002 (75 and 280 points) |
| FR-11 | Spent at payment, earned at Completed; cancel returns spent; No-Show returns nothing | `booking.ts` (spend), trigger `reservation_points_on_complete` (earn), `finishCancellation` (return) | `stay.test.ts` 1003 and cancellation rules; `db-rules.test.ts` points; `jobs.test.ts` No-Show |
| FR-12 | Add rooms and room types; update details except the price | Rooms and room types (administrator); `room_price` read-only + trigger `room_price_fixed`; room type/view additions (B18) | `crud.test.ts`, `db-rules.test.ts` room rules, `screens.test.ts` |
| FR-13 | Availability from dates and check-in/out events | `bookinn.assert_room_free`, `dashboard.roomAvailability` | `db-rules.test.ts` double booking; `screens.test.ts` dashboard; `jobs.test.ts` #25 |
| FR-14 | Create reservations | New booking form (`/book`), `createBooking` | `booking.test.ts` #1; `stay.test.ts` |
| FR-15 | View and cancel reservations | Reservation page; Cancel (guest request) | `booking.test.ts` #7, #17; `stay.test.ts` cancellation |
| FR-16 | Check availability when booking, editing and extending | `assertRoomAvailable` in `booking.ts`, `modify.ts`, `stay.ts`; DB trigger | `booking.test.ts` #5; `stay.test.ts` modification and extension |
| FR-17 | Prevent duplicate bookings | Server check + DB trigger with room row lock; Booked and Checked-In count | `booking.test.ts` #5, #6, #6b; `db-rules.test.ts` |
| FR-18 | Accurate reservation records | Constraints, status rules trigger, single transactions, audit trail | `schema.test.ts`, `db-rules.test.ts` |
| FR-19 | Edit a Booked reservation until the 48-hour cutoff; Modification charge (± ) paid at check-out | `modify.ts`, reservation page *Edit reservation* | `stay.test.ts` 1002 (+3,000), cutoff to the second, modification pricing |
| FR-20 | Extend during the stay only; Unpaid Extension charge | `stay.extendStay`, reservation page *Extend stay* | `stay.test.ts` 1001 extension, extension into another room |
| FR-21 | Check-in and check-out per room; early departure; Completed rule | `stay.checkInRoom` / `checkOutRoom`, `rules.tryComplete` | `stay.test.ts` early departure, Completed rule for multi-room |
| FR-22 | Daily job sets No-Show and emails the guest | `bookinn.mark_no_shows`, `maintenance.ts`, `email.sendNoShowNotice` | `jobs.test.ts` No-Show; `email.test.ts` No-Show notice |
| FR-23 | Record payment information | Initial at booking, Checkout at settlement; `PAY_TYPE` | `stay.test.ts` 1001 (Tables 13–14) |
| FR-24 | View and log payment records | Front Desk logs (booking, settlement), Finance views, administrator corrects | `rbac.test.ts`; `booking.test.ts` #21 |
| FR-25 | Maintain payment records | Kept until the one-year retention deletion | `jobs.test.ts` retention |
| FR-26 | One Checkout payment = Σ Unpaid charges; Checkout Credit if negative | `stay.settleCheckout`, reservation page *Settle the bill* | `stay.test.ts` 1001, Checkout Credit |
| FR-27 | 100% refund ≥ 48 h before earliest check-in, none later; unpaid edit charge voided | `rules.finishCancellation` | `stay.test.ts` 1003, cutoff, multi-room earliest check-in |
| FR-28 | Overdue list for Finance and the administrator, computed not stored | View `bookinn.overdue_reservation`, `overdue.ts`, `/overdue` | `db-rules.test.ts` overdue view; `email.test.ts` overdue list |
| FR-29 | Daily retention purge, skipping Unpaid; keep guests, loyalty, audit | `bookinn.purge_expired_reservations` | `jobs.test.ts` retention |

## Business rules (§3.3)

| Rule | Implementation | Verified by |
|---|---|---|
| Unique username, one role; only administrators manage accounts | `staff_u_name_uq`, `staff_u_name_lower_uq`, `perms` | `rbac.test.ts` |
| Audit trail view-only; no deleting records with dependents; only the purge cascades | Append-only trigger; `guard_dependent_delete` (B4) | `schema.test.ts`; `db-rules.test.ts` delete rules; `rbac.test.ts` |
| Deactivated accounts cannot log in | `is_active = 'Yes'` at login and on every request | `rbac.test.ts` |
| Password policy, salted hashes only | `isStrongPassword`, bcrypt, `pass` CHECK | `rbac.test.ts` |
| Guest needs name, mobile and email (unique) | NOT NULL + CHECKs, `customer_email_uq` | `crud.test.ts` |
| Data retention 1 year after latest check-out; skip Unpaid; keep guests, loyalty, audit | `purge_expired_reservations` (cascade, purge flag) | `jobs.test.ts` |
| Room needs number and type; price fixed per type; no price on the reservation | Schema; `room_price_fixed` | `schema.test.ts`, `db-rules.test.ts` |
| Room Type Rule: type locked once the room has a reservation | Trigger `room_type_locked` | `db-rules.test.ts` |
| Availability: Booked and Checked-In block; checked-in room blocked until checked out; half-open dates; own rooms left out when editing | `assert_room_free` (B3) | `db-rules.test.ts`, `stay.test.ts` |
| Extension: same room if free, else another room as a new row | `extendStay` | `stay.test.ts` |
| Asia/Manila; 48-hour cutoff = earliest check-in 14:00 − 48 h, exactly at the cutoff is on time | `dates.ts` `cutoffFor` / `beforeCutoff` | `stay.test.ts` |
| Daily job at 00:05 Manila: No-Show → Completed → purge; audit with no staff ID | `vercel.json` (`5 16 * * *` UTC), `maintenance.ts`, SQL functions | `jobs.test.ts`; `email.test.ts` schedule and endpoint |
| Points credited at Completed (check-out or job); spent deducted at payment, returned at cancellation | Trigger + `booking.ts` + `finishCancellation` | `stay.test.ts`, `db-rules.test.ts` |
| Overdue computed, not stored or scheduled | View, read on demand | `db-rules.test.ts` |
| Statuses and transitions (Table 3) | `reservation_status_rules` trigger, flow checks | `db-rules.test.ts` status rules; `stay.test.ts` |
| Only Booked can be edited or cancelled; only Checked-In extended | `modify.ts`, `finishCancellation`, `extendStay` | `stay.test.ts` |
| Check-in on or after the check-in date, never before | `checkInRoom`; CHECK `reservation_room_actual_in_chk` | `stay.test.ts`; `db-rules.test.ts` |
| Early departure shortens the stay, voids unused extension nights, no refund | `checkOutRoom` (B11) | `stay.test.ts` |
| Booking validity: guest, rooms, valid dates, not in the past | `booking.ts` | `booking.test.ts` #2–#4 |
| Modification pricing: changed rows re-priced whole; one ± charge; no discount; paid at check-out | `modify.ts` (B10) | `stay.test.ts` modification pricing |
| Amount due at check-out = Σ Unpaid charges incl. negative ones | `unpaidCharges`, `settleCheckout` | `stay.test.ts` |
| Guest cancellations only while Booked; no hotel cancellation | `finishCancellation`; no other path | `stay.test.ts` |
| No-Show handling and notice wording | `mark_no_shows`, `sendNoShowNotice` | `jobs.test.ts`, `email.test.ts` |
| One Initial, at most one Checkout payment per reservation | `payment_initial_uq`, `payment_checkout_uq` | `db-rules.test.ts` |
| Charge status Unpaid / Paid / Voided, stored on the charge | `adjustment_charge` CHECKs and trigger | `db-rules.test.ts` |
| Overpayment guard: payment must equal the amount due | `createBooking`, `settleCheckout`, `preparePayment` | `booking.test.ts` #9; `stay.test.ts` |
| Traceable receipt per payment, emailed | Receipt in the same transaction; `sendReceipt` after commit | `booking.test.ts` #11; `email.test.ts` |
| Refunds recorded in REFUND; confirmation emailed | `finishCancellation`, `settleCheckout`; `sendRefundConfirmation` | `stay.test.ts`; `email.test.ts` |
| Points = payment ÷ 100, decimals dropped; never earn and spend at once | `pointsEarned`, `payment_earn_xor_spend_chk` | `booking.test.ts` #12, #13 |
| One discount; 100 pts = 12%, 250 pts = free night (most expensive room); Initial only; ₱0 allowed | `amountDue`, `payment_discount_pts_chk`, `payment_checkout_no_discount_chk` | `booking.test.ts` #14–#16; `db-rules.test.ts` |

## Emails (SRS §1.4, §3.3)

| Email | Trigger (after commit) | Verified by |
|---|---|---|
| Receipt | Every payment: booking (Initial), settlement (Checkout), administrator payment form | `email.test.ts` |
| Refund confirmation | Every refund: cancellation (button or form), Checkout Credit, administrator refund form | `email.test.ts` |
| No-Show notice | Daily job, for each reservation set to No-Show | `email.test.ts` |
| Failure handling | Logged, never rolls back or interrupts; key never logged | `email.test.ts` |

## Not done or blocked by external setup

| Item | Status |
|---|---|
| Migrations 0004–0005 on Supabase | Not applied yet; tested on a copy of the old schema (`upgrade.test.ts`). Run `npm run db:migrate` after a backup. |
| Resend | Code ready; needs `RESEND_API_KEY`, `RESEND_FROM_EMAIL` and a verified domain. Until then emails are skipped and logged. |
| Scheduled job on Vercel | `vercel.json` cron and endpoint ready; needs `CRON_SECRET` in Vercel and a deploy. Not verified on Vercel. |
| Supabase Auth | Not used (SRS: own username and password in STAFF). |
