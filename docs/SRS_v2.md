# BookInn — Software Requirements Specification (v2, November 2026)

Prepared by Keizzy Dominique P. Alvarado, Jeremiah Joshua L. Esguerra, Jose Andre D.G. Evangelista and Jody Erich S. Medel.

> Source: `BookInn_SRS_APA_Tables.pdf` (November 2026). This file transcribes **Sections 1 to 4**, which are the
> source of truth for the implementation. Sections 5 onward (SQL Implementation, Interface Design, Testing and Results,
> Conclusion, User Manual, Appendices) are intentionally empty in the SRS and are not reproduced. Figures 1 to 3 and
> the ERD (Section 4.1) are images in the PDF; their content is covered by Table 1, Section 2.2 and Table 4.
> Where the SRS is silent or unclear, the implementation decisions are listed in `docs/SRS_AUDIT.md`; this file is
> not edited to record them.

---

## 1. Introduction

### 1.1 Background of the Study

The hospitality industry relies heavily on efficient information management to provide quality services to guests.
This is one of the most important processes in hotel operations. It involves managing guest information, room
availability, booking schedules, and reservation changes. Managing these records manually can become time-consuming
and may result in errors such as double booking, incorrect guest information, outdated room availability, and
misplaced records.

Traditional reservation methods, such as walk-in bookings, phone reservations, and manually maintained records, may
make it difficult for hotel staff to organize and retrieve information efficiently. The proposed Hotel Reservation
System, BookInn, is designed to provide a more organized and efficient way of managing hotel reservations. The system
will allow staff to view room availability, record and manage guest information, create and update reservations, and
maintain reservation records in a centralized database. By integrating these functions into one system, the proposed
solution aims to improve the accuracy, accessibility, and efficiency of the hotel.

### 1.2 Problem Statement

The client currently relies on a traditional file-based system to manage its reservations, guest records, and payment
transactions. This manual approach has resulted in several operational issues that affect the data integrity,
security, and efficiency of hotel operations. Specifically, this project seeks to address the following problems:
difficulty in retrieving past data, data redundancy, and data inconsistency.

Staff experience delays and difficulty retrieving past check-in records due to a long history of physically stored
information about previous guests. Meanwhile, when multiple guests share the same name or similar names, manual data
entry without a centralized identification system can lead to difficulty in distinguishing individual guest histories
and duplicate records. Lastly, updates made to one record aren't automatically updated in other traditional databases,
causing data inconsistencies.

### 1.3 Objectives

The general objective of this project is to develop a system that efficiently manages hotel room reservations and
related information through a centralized and organized information management system.

- To develop a system that efficiently manages hotel room reservations.
- To maintain accurate and organized guest and reservation information.
- To monitor room availability and prevent duplicate bookings.
- To provide quick and efficient retrieval of reservation records.
- To record guest check-in and check-out, and to support reservation modification, stay extension, and refund handling.
- To implement Role-Based Access Control (RBAC) to ensure users can only access features and information appropriate
  to their assigned roles.

### 1.4 Scope and Limitations

This project focuses on the development of a Hotel Reservation System and will only cover the following:

**Guest and Reservation Management**

- The system will collect and store guest information, including name, unique guest ID, contact number, and email.
- Reservation details such as room number, room type, room view with corresponding price, check-in date, check-out
  date, and booking status are all uniquely recorded through reservation IDs (RES_ID) and reservation room IDs
  (RES_ROOM_ID).
- Check-in and Check-out: Front desk staff record the actual check-in and check-out of each reserved room as separate
  events. A reservation moves through the statuses Booked, Checked-In, Completed, Cancelled, and No-Show.
- Reservation Editing: Front desk staff can edit a Booked reservation (room selection, dates, rooms added or removed)
  until 48 hours before the earliest check-in, subject to room availability. The guest on a reservation cannot be
  changed. Price changes caused by an edit are posted as charges and paid at check-out. Errors in Completed,
  Cancelled, or No-Show records are corrected only by the Database Administrator, and every correction is recorded in
  the audit trail.
- Cancellations: Only the guest can cancel a reservation. If the guest cancels at least 48 hours before the earliest
  check-in, they are entitled to a 100% refund of the amount paid. If the guest cancels later, no refund is issued.
  Once a room has been checked in, cancellation is no longer allowed. The hotel does not cancel reservations in this
  system.

**Reservation Extension**

- The system supports extension of a reservation during the stay only (after check-in), handled by the front desk
  staff, subject to room availability and priced at the room rate. Extension nights are paid at check-out.
- Lengthening a booking before check-in is a modification, not an extension.

**Payment-Related Data Record Keeping**

- The system will manage payment-related data for its corresponding reservations, including payment ID, payment type
  (Initial or Checkout), payment date, payment method, and total payment amount. Charges from edits and extensions,
  with their payment status, and refunds are also recorded. Loyalty points calculation and discount types are also
  included in the payment-related data.
- The initial booking is paid upfront. Charges from edits and extensions are paid in one payment at check-out.
- This system will NOT process these transactions itself, but rather keep its data for record-keeping and booking
  validation.

**User Authentication and Role-Based Access Control (RBAC)**

- The system will implement distinct access for different roles of each staff, ensuring that each staff type can only
  access functions and data relevant to their role or concern.

**Historical Record Retrieval**

- The system shall allow authorized users to retrieve reservation and check-in records within one (1) year from the
  reservation's latest check-out date to assist in verifying guest stays and resolving related concerns, such as lost
  items.
- The system shall permanently delete reservation records and all associated records, including reserved rooms,
  payments, receipts, charges, refunds, and cancellations, one (1) year after the reservation's latest check-out date.
  These records shall not be archived or retained beyond the one-year retention period. A reservation with an unpaid
  balance is reviewed by the Database Administrator and is not deleted until the balance is resolved.
- The system shall retain guest profiles, loyalty accounts, and audit trail entries permanently, regardless of the
  deletion of their associated reservation records.

**Loyalty Points System**

- The system will implement a loyalty points system where each guest may open a loyalty account that accumulates
  points based on the total amount spent in each transaction. These accumulated points may be consumed to avail special
  discounts such as a 12% total discount or a free night stay.
- Earned points are credited when the reservation is Completed. Spent points are deducted at payment. A guest who
  cancels does not earn points and regains the points spent on that reservation.

**Database and Deployment**

- The system will utilize PostgreSQL, hosted and managed through Supabase, as its database management system. Staff
  log in with a username and a password. The password is stored only as a hash in the STAFF table, and RBAC is
  enforced by the application on the server.
- The application will be built with Next.js and deployed on Vercel. Receipts and refund confirmations will be sent by
  email through Resend.

**Out of Scope**

- Online reservations and guest log-ins; all bookings are made through the front desk.
- Housekeeping and room status tracking (for example, cleaning or maintenance). Room availability is computed from
  reservation dates and check-in and check-out events, so no room status field is stored.
- Processing of payments and refunds; the system only records them.
- SMS notifications; all notices are sent by email.

---

## 2. System Overview

### 2.1 Stakeholders and Concerns

The process of BookInn involves several stakeholders who play different roles in managing and handling hotel
reservations. Each stakeholder interacts with the process and its data in ways that ensure accessibility, accuracy, and
availability of the reservation system. Identifying these stakeholders helps in distributing responsibilities and
information within the system.

**Table 1. Stakeholders and Concerns**

| Stakeholder | Role | Concerns |
|---|---|---|
| Front Desk Staff / Receptionist | Manages guest inquiries, reservations, check-in and check-out, modifications, extensions, and updates booking records, payment records, refunds, and guest accounts. | Accurate guest and room reservation data; avoiding double bookings, updated room availability, and retrieval of booking records. |
| Hotel Guests / Customers | Provides personal information and hotel reservations. Receives receipts and refund confirmations by email. | Accurate reservation details and confirmations, room availability, smooth reservation process. |
| Finance / Accounting Officers | Views payment information, charges, refund records, and overdue balances; is responsible for financial reporting. | Accurate payment records, refund records, unpaid balances, and financial information. |
| Database Administrator | Handles the technical side of the system – ensures accuracy, stability, security and performance of the database. | Data security and integrity, database availability, and system performance. Oversees the audit trail of the system. |

### 2.2 Existing Business Process

In a traditional hotel reservation system, guests make reservations through walk-ins. For walk-in reservations, guests
physically approach the front desk staff to inquire or book reservations, the front desk staff then manually check
available rooms and gather the necessary guest information (name, contact, room preference, time of check-in and
check-out, and payment details). Once the reservation is set, the reservation staff then record it in different
methods such as reservation forms, logbooks, and spreadsheets.

As reservations are made, modified, or cancelled, the front desk staff carry the burden of manually updating the
records to reflect changes in room availability and booking schedules in real time. This process may be more difficult
if handled manually through physical databases, especially if multiple reservations are being handled at the same
time.

These manual and disconnected practices create several bottlenecks in a hotel reservation system that compromise data
accuracy and user satisfaction. Manually checking and updating records can take additional time and may result in
inaccurate or outdated information, particularly when entering wrong information or when changes aren't reflected
across records immediately. Furthermore, the use of traditional recording of data – such as logbooks, forms, and
spreadsheets – is prone to human error, duplicate records, and misplaced information. As the number of reservations
increases, these bottlenecks make it more difficult for different staff to provide timely and accurate information to
guests.

### 2.3 Proposed Business Process and Database Solution

Using the proposed system, guest information on bookings or reservations is stored in a database. This information is
filled in by the front desk staff, who take the guest's information. Basic information about the guest, services they
will avail, and payment methods are among the information to be collected. Once double-checked and submitted, this
information (reservation and payment details) is stored and managed in the database of the system, with Role-Based
Access Control (RBAC) to ensure only employees have access to it. Each guest is also granted a unique guest I.D. to
prevent data discrepancies or duplications.

Guests need to call or talk with the front desk staff to update basic guest information, change a booking, or cancel
it. The front desk staff accesses the guest's booking details by logging in through RBAC and searching for the unique
reservation ID. When the booking status is updated, all employees see the reflected update, eliminating the need for
redundant revision.

The initial booking is paid upfront. Before check-in, front desk staff can edit a Booked reservation (room, dates, or
rooms added or removed) until 48 hours before the earliest check-in, subject to room availability. Room prices are
fixed per room type, so changed rooms are priced at the room rate. The price difference is posted as an unpaid charge
and settled at check-out.

When the guest arrives, front desk staff record the check-in of each room. During the stay, front desk staff can extend
a stay if a room is available. The extra nights are priced at the room rate and posted as an unpaid charge. At
check-out, front desk staff record the check-out and the guest pays all unpaid charges in one payment. Unused extension
nights are voided if the guest leaves early. If a reservation is still not checked out, or a charge is still unpaid,
after the latest check-out date, it appears on the overdue list that Finance and the Database Administrator can open.

If a guest cancels at least 48 hours before the earliest check-in, the system records a refund of 100% of the amount
paid, and the guest regains any points spent on the reservation. No refund is recorded for later cancellations, and a
reservation cannot be cancelled once a room has been checked in. Only guests cancel; the hotel does not cancel
reservations. The front desk hands over the refund, because BookInn only records it, and the guest receives a refund
confirmation by email.

If guests wish to open a loyalty account with the hotel, front desk staff may open an account for them and BookInn
shall generate a unique loyalty account ID for each guest who opens an account. For each payment transaction
completed, loyalty account holders earn points that are calculated by the system itself. Earned points are credited
once the reservation is Completed, while spent points are deducted at payment. These points may be used to avail a
special 12% discount or a free night.

BookInn does not allow a room to be booked for dates on which it already has a Booked or Checked-In reservation. Room
availability is computed from the check-in and check-out dates of existing reservations, so no separate room status is
stored. Any pre-existing reservation is taken into account when creating or editing a reservation. This prevents
double-booking from occurring. Should a cancellation occur, the rooms are automatically back in the pool of available
rooms for the previously booked dates.

Payments are processed physically by front desk staff, who then log the reservation's payment details such as payment
ID, payment type, payment date, payment method, and total payment amount, including how many loyalty points were
earned or spent and if a discount was availed, into the system. Front desk staff also record charges and refunds.
Payment records, receipts, charges, and refunds are viewable by finance staff for accurate payment information. All
permissions regarding payment require logging in to the Role-Based Access Control to safeguard transaction details.

Lastly, the database administrator maintains the system and information stored in it, ensuring all stakeholders have
access to updated and centralized information at all times. The database administrator reviews the security of the
database and system, making sure that all the processes mentioned earlier are possible. Access to the audit trail
concerned with information in the system is only given to the database administrator. Data is backed up regularly,
ensuring that even if the system goes down or the database encounters a problem, data is still recorded and
accessible.

---

## 3. System Requirements

### 3.1 Functional Requirements

BookInn shall provide the following functional modules and requirements for managing hotel reservations and related
information. (In the PDF, highlighted text is open for group discussion.)

**1. User Account Module**

- **FR-01:** The system shall allow staff to log in and log out of their accounts.
- **FR-02:** The system shall allow authorized users to create, update, and deactivate user accounts.
- **FR-03:** The system shall allow users to manage their account information.

**2. Role-Based Access Control (RBAC) Module**

- **FR-04:** The system shall allow administrators to assign and manage user roles.
- **FR-05:** The system shall enforce the permissions defined for each assigned role.
- **FR-06:** The system shall restrict access to system features and information according to the user's assigned role.

**3. Guest Management Module**

- **FR-07:** The system shall allow authorized users to add and update guest information.
- **FR-08:** The system shall allow authorized users to search and view guest records.
- **FR-09:** The system shall associate guest information with their corresponding reservations.
- **FR-10:** The system shall allow guests to request an opening of a loyalty account from the front desk. Loyalty
  accounts accumulate or spend loyalty points when making and paying for reservations.
- **FR-11:** The system shall deduct spent points at payment and credit earned points only when the reservation is
  Completed. When a guest cancels, the system shall return the points spent on the reservation and shall not credit
  earned points. When a reservation becomes a No-Show, spent points are not returned and no points are earned.

**4. Room Management Module**

- **FR-12:** The system shall allow authorized users to add rooms and room types, and to update room details other than
  the price.
- **FR-13:** The system shall display room availability, computed from the check-in and check-out dates and the
  check-in and check-out events of existing reservations, and room details.

**5. Reservation Management Module**

- **FR-14:** The system shall allow authorized users to create hotel reservations.
- **FR-15:** The system shall allow authorized users to view and cancel reservations.
- **FR-16:** The system shall check room availability during the reservation, reservation modification, and reservation
  extension processes.
- **FR-17:** The system shall prevent duplicate bookings for the same room and reservation period.
- **FR-18:** The system shall maintain accurate reservation records.
- **FR-19:** The system shall allow front desk staff to edit a Booked reservation (room, dates, and rooms added or
  removed) until 48 hours before the earliest check-in, subject to room availability. The guest cannot be changed. The
  price difference shall be posted as a Modification charge that is paid at check-out. A price decrease is posted as a
  negative charge that reduces the bill.
- **FR-20:** The system shall allow front desk staff to extend a stay during the stay only (Checked-In), subject to room
  availability, at the room rate. The extra nights shall be posted as an Unpaid Extension charge.
- **FR-21:** The system shall allow front desk staff to record the check-in and the check-out of each reserved room as
  separate events. A check-out before the room's check-out date is an early departure: the check-out date shall be set
  to the actual departure date, unused extension nights shall be voided, and no refund shall be given for prepaid
  nights. The reservation becomes Completed when no room is still checked in or still expected and all charges are
  settled.
- **FR-22:** The system shall, in a daily scheduled job, set a Booked reservation to No-Show when its latest check-out
  date has passed and no room was checked in, and then send the No-Show notice to the guest's email.

**6. Payment Record Module**

- **FR-23:** The system shall record payment information associated with hotel reservations.
- **FR-24:** The system shall allow authorized users to view and log payment records.
- **FR-25:** The system shall maintain payment records for hotel record-keeping purposes.
- **FR-26:** The system shall settle all Unpaid charges of a reservation in one Checkout payment at check-out, equal to
  the sum of those charges. If the sum is negative, the system shall record a Checkout Credit refund instead of a
  payment.
- **FR-27:** The system shall record a refund in the REFUND entity equal to 100% of the amount paid when a guest cancels
  at least 48 hours before the earliest check-in, and no refund for later cancellations. When a reservation with an
  unpaid edit charge is cancelled, the unpaid charge is voided, and only the paid amount is refunded.
- **FR-28:** The system shall show Finance and the Database Administrator a list of overdue reservations. Overdue is
  computed from the dates and charges and is not stored: a reservation is overdue when its latest check-out date is
  before today and it is still Checked-In or has an Unpaid charge.

**7. Records Retention Module**

- **FR-29:** The system shall, in a daily scheduled job, delete a reservation and all its associated records one (1)
  year after its latest check-out date, skip reservations with Unpaid charges until the Database Administrator
  resolves them, and keep guest profiles, loyalty accounts, and audit trail entries permanently.

### 3.2 Non-Functional Requirements

BookInn requires several non-functional requirements to ensure reliability and efficiency. Performance-wise, the system
must maintain fast responsiveness, quickly process room availability checks, reservations, and payments within 2-3
seconds, as Website Speedy (2025) stated that 47% of users expect a website or system to load in 2 seconds, where every
single second of extra load time can reduce user satisfaction by 16%. Since the system will be used by multiple
stakeholders – such as front desk staff, finance officers, and database administrators – maintaining a 2-3 second
threshold for response time ensures that the system remains efficient, stable, and user-friendly.

In terms of Security and Data Integrity, the system should implement RBAC (Role-Based Access Control) to restrict data
access based on user roles and ensure data encryption using HTTPS. The system should also maintain at least 99%
operational availability, with regular automated database backups to avoid data loss. Lastly, its codebase and schema
should be well-documented so database administrators can easily troubleshoot or update the codebase efficiently.

### 3.3 Business Rules

To keep operations running smoothly and prevent data conflicts, BookInn enforces clear rules across all its modules.
These guidelines reflect standard hotel management practices and align with common commercial reservation systems.

#### User Accounts & System Access

- **Unique Credentials:** Every account requires a unique username and must be tied to a single role (such as Database
  Administrator, Front Desk Staff, or Finance Officer).
- **Admin Control:** Only Database Administrators can create, edit, deactivate, or reassign user account roles. They
  have viewing, editing, and deletion access to all data – except the audit trail, which is view-only in the database.
  Users cannot delete records that other records depend on. Only the scheduled one-year retention purge removes a
  reservation together with its dependent records.
- **Account Deactivation:** Deactivated accounts cannot log in, but the system retains their historical activity for
  auditing.
- **Role Permissions:** Users can only access the features allowed by their role. The system blocks any unauthorized
  attempts:

**Table 2. Role Permissions by User Type**

| Permissions | Front Desk | Finance | Database Administrator |
|---|---|---|---|
| Customer, loyalty account | Create, read, and update | Read | All |
| Room, room details | Read | Read | All, except ROOM_PRICE, which is set when a room type is created and never edited |
| Reservation, reserved rooms (including check-in and check-out) | Create, read, update, cancel, check in, and check out | Read | All |
| Payment, receipt | Create, read | Read | All |
| Charge (edit and extension) | Create, read, update (settle or void) | Read | All |
| Refund | Create, read | Read | All |
| Cancellation | Create, read | Read | All |
| Staff | None, except their own account | None, except their own account | All |
| Audit Trail | None | None | Read Only |

- **Password Security:** All passwords must meet minimum security standards (a combination of uppercase letters,
  lowercase letters, numbers, and special characters). Passwords are stored only as salted hashes (for example bcrypt)
  in STAFF.PASS and are never stored or shown as plain text.

#### Guest Records

- **Required Details:** Guests need a unique ID alongside complete basic details (full name, contact number and email)
  before staff can finalize a booking under their name. The guest is required to provide an email, as generated
  receipts will be sent via email.
- **Guest History:** A guest can book multiple stays over time, but each reservation maps back to a single primary guest
  record.
- **Data Retention:** Guest profiles, loyalty accounts, and audit trail entries are retained permanently. One (1) year
  after a reservation's latest check-out date, the reservation and all its related records (reserved rooms, payment,
  receipt, charge, refund, and cancellation) are permanently deleted. These records are not archived. A reservation
  with an Unpaid charge is skipped by the deletion until the Database Administrator resolves the balance.

#### Room Operations

- **Setup Requirements:** Every room requires a distinct room number and an assigned room type. The view and price per
  night come from the room type. Room prices are fixed: the price of a room type does not change, so bills are computed
  from ROOM_DETAILS and no price is stored on the reservation.
- **Room Type Rule:** A room's type cannot be changed once the room has any reservation, and the price of a room type
  is set when the type is created and never edited. A rate change means creating a new room type. A guest may still
  change a booking to a room of another type under Modification.
- **Room Availability:** Availability is computed from the dates and check-in and check-out events of existing
  reservations. No room status field is stored, because housekeeping and maintenance tracking are out of scope. A room
  is unavailable for a date range when a Booked or Checked-In reservation overlaps it. A Checked-In room stays
  unavailable until it is checked out, even past its check-out date. Reservations that are Cancelled, Completed, or
  No-Show are not counted.
- **Double-Booking Prevention:** Reserving a room takes into account pre-existing Booked and Checked-In reservations so
  that the new check-in and check-out dates do not overlap them. Date ranges are half-open, so a new check-in may fall
  on another booking's check-out date. When a booking is edited, its own rooms are left out of the check.
- **Room Availability for Reservation Extensions:** When extending a stay in a room, the system will check if the
  room's following nights are free, then extend it. If not, then offer another room for the extension as a new
  reservation_room row. Extra nights are priced at the room rate.

#### Dates and Times

- All dates and times use Asia/Manila time. The standard check-in time is 14:00 and the standard check-out time is
  12:00.
- The 48-hour cutoff is the earliest check-in date at 14:00 minus 48 hours. An action made exactly at the cutoff is
  still on time.
- When a reservation has several rooms with different check-in dates, the earliest check-in applies to the whole
  reservation for the cancellation and modification cutoffs.

#### Scheduled and Automatic Actions

- **Daily job:** Every day at 00:05 Asia/Manila time the system runs one scheduled job that does three things in this
  order. First, it sets to No-Show every Booked reservation whose latest check-out date is before today and that has no
  room checked in, then sends the No-Show notice email to the guest. Second, it sets to Completed every Checked-In
  reservation that has no room checked in, no room still expected, and no Unpaid charge, and credits the earned points.
  Third, it permanently deletes every reservation whose latest check-out date is one (1) year or more before today,
  together with its related records, and skips any reservation with an Unpaid charge until the Database Administrator
  resolves it.
- **Event-driven actions:** Earned points are credited as soon as a reservation becomes Completed, whether at a
  check-out or in the daily job. Spent points are deducted at payment and returned at cancellation. These actions are
  not scheduled.
- **Computed, not scheduled:** The overdue list is computed each time it is opened and is not part of the daily job.
- **Audit:** Changes made by the daily job are recorded in the audit trail with no staff ID.

#### Reservation Status

**Table 3. Reservation Statuses**

| Status | Meaning | How it is reached |
|---|---|---|
| Booked | Reserved and paid upfront; no room checked in yet | Created at booking |
| Checked-In | At least one room has been checked in | Front desk checks in the first room |
| Completed | No room is still checked in or still expected, and all charges are settled | Front desk records the last check-out and settles the bill; a room never checked in is ignored once its check-out date has passed |
| Cancelled | Cancelled by the guest before any check-in | Guest cancels a Booked reservation |
| No-Show | Latest check-out date passed and no room was checked in | Set by the daily scheduled job, which then emails the guest |

Only Booked reservations can be edited or cancelled. Only Checked-In reservations can be extended. Completed,
Cancelled, and No-Show reservations cannot be changed except by Database Administrator correction.

#### Check-in and Check-out

- **Check-in:** Front desk staff record a room's check-in on or after its check-in date, never before. The actual
  check-in time is stored on the reserved room, and the reservation becomes Checked-In.
- **Check-out:** Front desk staff record each room's check-out. At the check-out that leaves no room checked in, the
  guest pays all Unpaid charges in one Checkout payment. The reservation becomes Completed at that point if no other
  room is still expected (every other room is checked out, or was never checked in and is past its check-out date).
  Otherwise it becomes Completed when the daily scheduled job finds that no room is still expected, and the earned
  points are credited at that moment.
- **Early Departure:** A check-out before the room's check-out date shortens the check-out date to the actual departure
  date. Unused extension nights are voided. There is no refund for remaining prepaid nights.
- **Overdue:** Overdue is computed, not stored, so there is no overdue column and no scheduled job for it. A database
  view lists every reservation whose latest check-out date is before today and that is still Checked-In or has an
  Unpaid charge. Finance and the Database Administrator open this list, and it is always current because it is
  recalculated each time it is opened.

#### Reservations

- **Booking Validity:** Every booking requires a verified guest, assigned room(s), and valid travel dates that are
  checked to prevent double-bookings. A valid booking also does not allow bookings that start in the past. Reservation
  extensions may start on the day the extension is being made, if the room is free for those dates.
- **Modification:** Only a Booked reservation can be edited, and only until the 48-hour cutoff. Front desk staff may
  change the room, the dates, or add and remove rooms. The guest cannot be changed. The edit passes the same overlap
  check as a new booking.
- **Modification Pricing:** A changed room row is re-priced as a whole at the room rate of its room type. The
  difference between the new and old total of the changed rows is posted as a Modification charge on the reservation:
  positive for an increase, negative for a decrease.
- **Modification Payment:** The Modification charge is not paid when the edit is saved. It is paid at check-out
  together with the other charges. No loyalty discount applies to it.
- **Lengthening Before Check-in:** Lengthening a booking before check-in is a modification. Lengthening during the stay
  is an extension. Both are posted as charges paid at check-out.
- **Extension:** An extension is allowed only while the reservation is Checked-In and the room is free. The room's
  check-out date is extended in place, or a new reservation room row is added when another room is offered. The extra
  nights are posted as an Unpaid Extension charge at the room rate.
- **Payment Settlement:** The initial booking is paid upfront when the reservation is made. Edits and extensions are
  paid at check-out.
- **Amount Due at Check-out:** The amount due is the sum of the reservation's Unpaid charges, including negative ones.

#### Cancellations & No-Shows

- **Guest Cancellations:** Only guests cancel, and only through front desk staff. A cancellation is allowed while the
  reservation is Booked. A cancellation at least 48 hours before the earliest check-in refunds 100% of the amount paid.
  A cancellation within 48 hours receives no refund. Once a room has been checked in, no cancellations are allowed.
  Checking out early is an early departure with no refund for remaining prepaid nights.
- **Points on Cancellation:** The guest regains the points spent on the cancelled reservation, and earned points are
  never credited. This applies to every cancellation, including one inside 48 hours that receives no refund.
- **No Hotel Cancellation:** The system has no hotel-initiated cancellation.
- **No-Show Handling:** Once a reservation's latest check-out date has passed and no room was ever checked in, the daily
  scheduled job sets the reservation to No-Show and then sends the No-Show notice to the guest's provided email. The
  notice states that the reservation was marked No-Show, that no refund is given, and that spent points are not
  returned. No points are earned.

#### Payments & Receipts

- **Transaction Tracking:** Every payment record attaches to a single reservation and records the amount, date, payment
  method, and payment type (Initial or Checkout). A reservation has exactly one Initial payment and at most one
  Checkout payment.
- **Charge Status:** Every charge from an edit or extension has a payment status: Unpaid, Paid, or Voided. A charge is
  Paid when it is settled by the Checkout payment, and Voided when it is cancelled or unused. The payment status is
  stored on the charge, not on the Initial payment, which is always paid when it is logged.
- **Overpayment Guard:** The system rejects any payment that does not equal the amount due. The amount due is the
  discounted total for an Initial payment and the sum of Unpaid charges for a Checkout payment.
- **Initial Payment:** Initial payments to reservations are prepaid.
- **Checkout Payment:** Payment for edits and extensions is settled in one payment at check-out.
- **Receipt Generation:** The system issues a traceable receipt for every payment, linking it directly to the
  transaction record. Each generated receipt is sent to the guest's provided email.
- **Refund Policy:** Refunds are recorded in REFUND. A guest cancellation at least 48 hours before the earliest
  check-in refunds 100% of the amount paid. A later cancellation receives no refund. A Checkout Credit refund is
  recorded only when the charges at check-out add up to less than zero.
- **Refund Handling:** The front desk records the refund and hands over the money, because BookInn only records
  transactions. The guest receives a refund confirmation by email.
- **Payment Permissions:** The front desk will also be in charge of logging payment, charge, and refund records, while
  finance officers get viewing access to payment records, receipts, charges, and refunds.

#### Loyalty Accounts and Pointing System

- Earned points are given once the reservation is Completed, while spent points are deducted immediately at payment.
  When a guest cancels, the spent points are returned and earned points are never credited.
- Points earned in a transaction are calculated by taking the total payment amount and dividing it by 100. Excess
  decimals are discarded and not kept or added to the next transaction point earnings.
- You cannot earn points and spend points at the same time in a single transaction.
- When selecting a loyalty discount type to avail, only one discount type per transaction may apply. There are
  currently two discounts available in the system: 100 points for a 12% discount and 250 points for a free night.
  Discounts apply to Initial payments only. Checkout payments use NONE.
- When availing the 12% discount, 12% of the total payment amount is deducted from the total payment. When availing the
  free night discount, this automatically applies to the most expensive room booked in the reservation. One night's
  price of the room is deducted from the total payment amount. If the transaction avails the free night discount with
  only one room booked for one night, payment is still logged in the system with a total payment amount of 0.

---

## 4. Database Design and Schema

### 4.1 Entity-Relationship Diagram (ERD)

The ERD is an image in the PDF. Its relationships are listed in Table 4.

**Table 4. Relationships in the Revised ERD**

| Relationship | Entities | Cardinality | Status |
|---|---|---|---|
| HAS | CUSTOMER – LOYALTY_ACC | 1:1 (a guest may open one account) | Unchanged |
| MAKES | CUSTOMER – RESERVATION | 1:M | Unchanged |
| INCLUDES | RESERVATION – RESERVATION_ROOM | 1:M | Unchanged |
| BOOKED VIA | RESERVATION_ROOM – ROOM | M:1 | Unchanged |
| HAS | ROOM – ROOM_DETAILS | M:1 | Unchanged |
| HAS | RESERVATION – PAYMENT | 1:M | Changed from 1:1 |
| GENERATES | PAYMENT – RECEIPT | 1:1 | Unchanged; RECEIPT is keyed by PAY_ID only |
| HAS | RESERVATION – CANCELLATION | 1:1 (optional) | Unchanged |
| CHARGED BY | RESERVATION – ADJUSTMENT_CHARGE | 1:M (Extension charges also name the RESERVATION_ROOM) | New |
| SETTLES | PAYMENT – ADJUSTMENT_CHARGE | 1:M (a charge is settled by at most one payment; one checkout payment can settle several charges) | New |
| RECEIVES | RESERVATION – REFUND | 1:M | New |
| HANDLES | STAFF – AUDIT_TRAIL | 1:M | Unchanged |

**Table 5. Attribute Changes by Entity**

| Entity | Attribute change |
|---|---|
| RESERVATION | BOOKING_STATUS values: Booked, Checked-In, Completed, Cancelled, No-Show |
| PAYMENT | Adds PAY_TYPE (Initial, Checkout) |
| RESERVATION_ROOM | Adds ACTUAL_CHECK_IN, ACTUAL_CHECK_OUT |
| ADJUSTMENT_CHARGE (new) | CHARGE_ID, RES_ID, RES_ROOM_ID (optional), CHARGE_TYPE, EXT_FROM, EXT_TO, CHARGE_AMT, PAY_STATUS, PAY_ID |
| REFUND (new) | REFUND_ID, RES_ID, REFUND_TYPE, REFUND_AMT, REFUND_DATE |
| STAFF | No change (STAFF_ID, U_NAME, PASS, NAME, ROLE, IS_ACTIVE) |
| AUDIT_TRAIL | AFF_TAB adds ADJUSTMENT_CHARGE and REFUND |

### 4.2 Normalization (1NF, 2NF, 3NF)

Only the groups affected by the changes are redrawn here. The customer, loyalty, room, and staff groups follow the
earlier tables. PK and FK are marked in the final 3NF tables.

**UNF: reservations with repeating payment, charge, and refund groups**

**Table 6. Unnormalized Form (UNF) of Reservations with Repeating Payment, Charge, and Refund Groups**

| RES_ID | PAY_ID | PAY_TYPE | PAY_AMT | CHARGE_ID | CHARGE_TYPE | CHARGE_AMT | PAY_STATUS | REFUND_ID | REFUND_AMT |
|---|---|---|---|---|---|---|---|---|---|
| 1001 | 1001, 1004 | Initial, Checkout | 6000, 1500 | 7001 | Extension | 1500 | Paid | NULL | NULL |
| 1002 | 1002 | Initial | 5280 | 7002 | Modification | 3000 | Unpaid | NULL | NULL |
| 1003 | 1003 | Initial | 6000 | NULL | NULL | NULL | NULL | 8001 | 6000 |

**1NF.** The repeating values are split so that each payment, charge, and refund is its own row with atomic values.
The PAYMENT key stays PAY_ID, and RES_ID stops being unique.

**2NF.** The charge and refund attributes do not depend on the whole payment key. They move into ADJUSTMENT_CHARGE (key
CHARGE_ID) and REFUND (key REFUND_ID).

**3NF.**

- RES_ID is stored in ADJUSTMENT_CHARGE so that a Modification charge stays with its reservation even when an edit
  removes or replaces the room row. RES_ROOM_ID is filled only for Extension charges.
- Room prices are fixed, so no price is stored on RESERVATION_ROOM. The night price is read from ROOM_DETAILS through
  ROOM, which avoids a duplicate of ROOM_PRICE. CHARGE_AMT and REFUND_AMT are stored amounts of facts at that moment. A
  Modification charge cannot be recalculated later, because the room row is overwritten by the edit.
- The reservation status is stored on RESERVATION. Room occupancy and availability are not stored; they are computed
  from the dates and the ACTUAL_CHECK_IN and ACTUAL_CHECK_OUT columns.

**Final 3NF tables (sample data)**

**Table 7. Customer**

| CUS_ID (PK) | CUS_NAME | CUS_EMAIL | CUS_MOBILE |
|---|---|---|---|
| 1001 | JUAN DELA CRUZ | jdcruz@gmail.com | 09061234567 |
| 1002 | KEIZZY ALVARADO | kdpalvarado@gmail.com | 09761234567 |

**Table 8. Loyalty Account**

| LYL_ID (PK) | CUS_ID (FK) | TOTAL_PTS |
|---|---|---|
| 5001 | 1001 | 75 |
| 5002 | 1002 | 250 |

**Table 9. Reservation**

| RES_ID (PK) | CUS_ID (FK) | BOOKING_STATUS |
|---|---|---|
| 1001 | 1001 | Completed |
| 1002 | 1002 | Booked |
| 1003 | 1001 | Cancelled |

**Table 10. Reservation Room**

| RES_ROOM_ID (PK) | RES_ID (FK) | ROOM_NO (FK) | CHECK_IN_DATE | CHECK_OUT_DATE | ACTUAL_CHECK_IN | ACTUAL_CHECK_OUT |
|---|---|---|---|---|---|---|
| 10001 | 1001 | 205 | 06-25-2026 | 06-28-2026 | 06-25-2026 14:10 | 06-28-2026 11:40 |
| 10002 | 1001 | 206 | 06-25-2026 | 06-27-2026 | 06-25-2026 14:10 | 06-27-2026 11:30 |
| 10003 | 1002 | 108 | 10-08-2026 | 10-11-2026 | NULL | NULL |
| 10004 | 1003 | 406 | 09-25-2026 | 09-29-2026 | NULL | NULL |

**Table 11. Room**

| ROOM_NO (PK) | ROOM_TYPE_ID (FK) |
|---|---|
| 205 | RT01 |
| 206 | RT01 |
| 108 | RT02 |
| 406 | RT01 |

**Table 12. Room Details**

| ROOM_TYPE_ID (PK) | ROOM_TYPE | ROOM_PRICE | ROOM_VIEW |
|---|---|---|---|
| RT01 | Standard | 1500 | Ocean View |
| RT02 | Deluxe | 3000 | Pool View |

**Table 13. Payment**

| PAY_ID (PK) | RES_ID (FK) | PAY_TYPE | PAY_METHOD | PAY_DATE | PAY_AMT | PTS_EARN | PTS_SPEND | DISCOUNT_TYPE |
|---|---|---|---|---|---|---|---|---|
| 1001 | 1001 | Initial | Digital Wallet | 06-20-2026 | 6000 | 60 | 0 | NONE |
| 1002 | 1002 | Initial | Cash | 08-07-2026 | 5280 | 0 | 100 | 12% Discount |
| 1003 | 1003 | Initial | Digital Wallet | 09-11-2026 | 6000 | 60 | 0 | NONE |
| 1004 | 1001 | Checkout | Cash | 06-28-2026 | 1500 | 15 | 0 | NONE |

**Table 14. Receipt**

| RCT_NO (PK) | PAY_ID (FK) |
|---|---|
| 1001 | 1001 |
| 1002 | 1002 |
| 1003 | 1003 |
| 1004 | 1004 |

**Table 15. Cancellation**

| CANCEL_ID (PK) | RES_ID (FK) | CANCEL_DATE |
|---|---|---|
| 9001 | 1003 | 09-15-2026 |

**Table 16. Adjustment Charge**

| CHARGE_ID (PK) | RES_ID (FK) | RES_ROOM_ID (FK) | CHARGE_TYPE | EXT_FROM | EXT_TO | CHARGE_AMT | PAY_STATUS | PAY_ID (FK) |
|---|---|---|---|---|---|---|---|---|
| 7001 | 1001 | 10001 | Extension | 06-27-2026 | 06-28-2026 | 1500 | Paid | 1004 |
| 7002 | 1002 | NULL | Modification | NULL | NULL | 3000 | Unpaid | NULL |

**Table 17. Refund**

| REFUND_ID (PK) | RES_ID (FK) | REFUND_TYPE | REFUND_AMT | REFUND_DATE |
|---|---|---|---|---|
| 8001 | 1003 | Cancellation | 6000 | 09-15-2026 |

**Table 18. Staff**

| STAFF_ID (PK) | PASS | U_NAME | NAME | ROLE | IS_ACTIVE |
|---|---|---|---|---|---|
| 1001 | [hashed password 1] | KDPALVARADO | Keizzy Dominique Alvarado | Front Desk | Yes |
| 1002 | [hashed password 2] | JESMEDEL | Jody Erich Medel | Finance | No |

**Table 19. Audit Trail**

| AUDIT_ID (PK) | STAFF_ID (FK) | ACTION | AFF_TAB | REC_ID | TIMESTAMP | OLD_DATA | NEW_DATA |
|---|---|---|---|---|---|---|---|
| 1001 | 1001 | INSERT | ADJUSTMENT_CHARGE | 7001 | 06-26-2026 14:05 | NULL | RES_ID=1001; RES_ROOM_ID=10001; EXT_TO=06-28-2026 |
| 1002 | NULL | UPDATE | LOYALTY_ACC | 5001 | 06-28-2026 11:45 | TOTAL_PTS=0 | TOTAL_PTS=75 |
| 1003 | 1001 | INSERT | ADJUSTMENT_CHARGE | 7002 | 08-07-2026 10:20 | NULL | RES_ID=1002; CHARGE_AMT=3000 |
| 1004 | 1001 | INSERT | CANCELLATION | 9001 | 09-15-2026 09:17 | NULL | RES_ID=1003 |
| 1005 | 1001 | INSERT | REFUND | 8001 | 09-15-2026 09:17 | NULL | RES_ID=1003; REFUND_AMT=6000 |

**Sample data check:** the snapshot is dated 09-15-2026. Reservation 1001 was checked out and its bill settled, so it is
Completed and account 5001 holds 60 + 15 = 75 points. Reservation 1003 was cancelled 10 days before check-in, so the
6,000 paid is refunded in full and its 60 earned points are never credited. Reservation 1002 is still Booked: its edit
on 08-07 (check-out moved from 10-10 to 10-11) is posted as an Unpaid Modification charge of 3,000 that is paid at
check-out, and its 100 spent points are already deducted. The audit row 1002 has no staff ID because the system
credits points automatically.

### 4.3 Relational Schema

**Table 20. Relational Schema Keys and Delete Rules**

| Table | Primary key | Foreign keys | On delete | Change |
|---|---|---|---|---|
| CUSTOMER | CUS_ID | None | Not applicable | None |
| LOYALTY_ACC | LYL_ID | CUS_ID → CUSTOMER (unique) | Restrict | None |
| RESERVATION | RES_ID | CUS_ID → CUSTOMER | Restrict | BOOKING_STATUS values extended |
| RESERVATION_ROOM | RES_ROOM_ID | RES_ID → RESERVATION; ROOM_NO → ROOM | Cascade from RESERVATION; restrict from ROOM | ACTUAL_CHECK_IN, ACTUAL_CHECK_OUT added |
| ROOM | ROOM_NO | ROOM_TYPE_ID → ROOM_DETAILS | Restrict | None |
| ROOM_DETAILS | ROOM_TYPE_ID | None | Not applicable | None |
| PAYMENT | PAY_ID | RES_ID → RESERVATION (no longer unique) | Cascade from RESERVATION | PAY_TYPE added |
| RECEIPT | RCT_NO | PAY_ID → PAYMENT (unique) | Cascade from PAYMENT | None |
| CANCELLATION | CANCEL_ID | RES_ID → RESERVATION (unique) | Cascade from RESERVATION | None |
| ADJUSTMENT_CHARGE | CHARGE_ID | RES_ID → RESERVATION; RES_ROOM_ID → RESERVATION_ROOM (nullable); PAY_ID → PAYMENT (nullable) | Cascade from RESERVATION; set null on RES_ROOM_ID and PAY_ID | New table |
| REFUND | REFUND_ID | RES_ID → RESERVATION | Cascade from RESERVATION | New table |
| STAFF | STAFF_ID | None | Not applicable | No change (STAFF_ID, U_NAME, PASS, NAME, ROLE, IS_ACTIVE) |
| AUDIT_TRAIL | AUDIT_ID | STAFF_ID → STAFF (nullable) | Restrict | AFF_TAB extended |

The cascade from RESERVATION supports the one-year deletion and leaves guest profiles and loyalty accounts untouched.
ADJUSTMENT_CHARGE is deleted with its reservation. ADJUSTMENT_CHARGE.PAY_ID and RES_ROOM_ID are set to null instead of
cascading, so a purge that removes a reservation's payments and rooms together does not fail.

### 4.4 Data Dictionary

**Table 21. Customer**

| Column | Data type | Key | Description | Notes |
|---|---|---|---|---|
| CUS_ID | int | PK | Unique customer ID | |
| CUS_NAME | varchar(100) | | Customer full name | |
| CUS_EMAIL | varchar(100) | | Customer email address | Unique; required because receipts are emailed |
| CUS_MOBILE | varchar(12) | | Customer mobile number | Stored as text to keep leading zeros |

**Table 22. Loyalty Account**

| Column | Data type | Key | Description | Notes |
|---|---|---|---|---|
| LYL_ID | int | PK | Unique loyalty account ID | |
| CUS_ID | int | FK | Owner of the account | References CUSTOMER.CUS_ID; Unique |
| TOTAL_PTS | int | | Current total loyalty points | Spent points are deducted at payment and returned when the guest cancels; earned points are added when the reservation is Completed; cannot be negative |

**Table 23. Reservation**

| Column | Data type | Key | Description | Notes |
|---|---|---|---|---|
| RES_ID | int | PK | Unique reservation ID | |
| CUS_ID | int | FK | Customer who made the booking | References CUSTOMER.CUS_ID |
| BOOKING_STATUS | enum | | Current status of the booking | Allowed values: Booked, Checked-In, Completed, Cancelled, No-Show. Completed requires that no room is still checked in or still expected (a room never checked in is ignored once its check-out date has passed) and no Unpaid charge |

**Table 24. Reservation Room**

| Column | Data type | Key | Description | Notes |
|---|---|---|---|---|
| RES_ROOM_ID | int | PK | Unique ID for a room within a reservation | |
| RES_ID | int | FK | Parent reservation | References RESERVATION.RES_ID |
| ROOM_NO | int | FK | Room booked | References ROOM.ROOM_NO |
| CHECK_IN_DATE | date | | Planned check-in date | |
| CHECK_OUT_DATE | date | | Planned check-out date | Must be after check-in. Extended in place by an in-stay extension; shortened by an early departure |
| ACTUAL_CHECK_IN | timestamp | | When the room was actually checked in | NULL until check-in; Asia/Manila time; not before CHECK_IN_DATE |
| ACTUAL_CHECK_OUT | timestamp | | When the room was actually checked out | NULL until check-out; must be after ACTUAL_CHECK_IN |

**Table 25. Room**

| Column | Data type | Key | Description | Notes |
|---|---|---|---|---|
| ROOM_NO | int | PK | Room number | |
| ROOM_TYPE_ID | varchar(4) | FK | Category of the room | References ROOM_DETAILS.ROOM_TYPE_ID. Cannot be changed once the room has any reservation. No room status column: availability is computed |

**Table 26. Room Details**

| Column | Data type | Key | Description | Notes |
|---|---|---|---|---|
| ROOM_TYPE_ID | varchar(4) | PK | Short code for the room type | |
| ROOM_TYPE | enum | | Name of the room type | Allowed values: Standard, Deluxe; the Database Administrator can add more room types and views |
| ROOM_PRICE | decimal | | Price of the room type | Precision (8,2) per night; cannot be negative. Fixed: set when the room type is created and never edited. A rate change means creating a new room type |
| ROOM_VIEW | enum | | View of the room type | Allowed values: Ocean View, City View, Garden View, Pool View |

**Table 27. Payment**

| Column | Data type | Key | Description | Notes |
|---|---|---|---|---|
| PAY_ID | int | PK | Unique payment ID | |
| RES_ID | int | FK | Reservation being paid | References RESERVATION.RES_ID. Not unique, so one reservation can have several payments |
| PAY_TYPE | enum | | Purpose of the payment | Allowed values: Initial, Checkout. One Initial and at most one Checkout per reservation |
| PAY_METHOD | enum | | How the payment was made | Allowed values: Cash, Bank, Card, Digital Wallet |
| PAY_DATE | date | | Date of payment | |
| PAY_AMT | decimal | | Amount paid | Precision (8,2); cannot be negative. Must equal the amount due for that payment type |
| PTS_EARN | int | | Loyalty points earned from this payment | Cannot be negative. Credited to the account when the reservation is Completed; never credited if the reservation is cancelled. Is 0 if the guest has no loyalty account |
| PTS_SPEND | int | | Loyalty points spent on this payment | Cannot be negative. Initial payments only. Deducted immediately and returned if the guest cancels |
| DISCOUNT_TYPE | enum | | Type of discount applied | Allowed values: 12% Discount, Free Night, NONE. Checkout payments use NONE |

**Table 28. Receipt**

| Column | Data type | Key | Description | Notes |
|---|---|---|---|---|
| RCT_NO | int | PK | Receipt number | |
| PAY_ID | int | FK | Payment the receipt is for | References PAYMENT.PAY_ID; Unique |

**Table 29. Cancellation**

| Column | Data type | Key | Description | Notes |
|---|---|---|---|---|
| CANCEL_ID | int | PK | Unique cancellation ID | |
| RES_ID | int | FK | Cancelled reservation | References RESERVATION.RES_ID; Unique |
| CANCEL_DATE | date | | Date of cancellation | |

Note. Every cancellation is made by the guest, so there is no cancelled-by column. A no-show is not recorded here; its
reservation status becomes No-Show. Refunds, if any, are recorded in REFUND.

**Table 30. Adjustment Charge**

| Column | Data type | Key | Description | Notes |
|---|---|---|---|---|
| CHARGE_ID | int | PK | Unique charge ID | |
| RES_ID | int | FK | Reservation the charge belongs to | References RESERVATION.RES_ID; required. A Modification charge belongs only to the reservation |
| RES_ROOM_ID | int | FK | Room row an Extension charge belongs to | References RESERVATION_ROOM.RES_ROOM_ID; nullable: filled for Extension charges, NULL for Modification charges |
| CHARGE_TYPE | enum | | Source of the charge | Allowed values: Extension, Modification |
| EXT_FROM | date | | First extra night | Extension charges only; NULL for Modification |
| EXT_TO | date | | Extended check-out date | Extension charges only; must be after EXT_FROM |
| CHARGE_AMT | decimal | | Amount of the charge | Precision (8,2). Positive for an increase, negative for a decrease. Extension amount = nights × ROOM_PRICE of the room when posted |
| PAY_STATUS | enum | | Payment status of the charge | Allowed values: Unpaid, Paid, Voided. Paid when settled at check-out; Voided when cancelled or unused |
| PAY_ID | int | FK | Payment that settled the charge | References PAYMENT.PAY_ID; NULL until Paid, and NULL if settled by a Checkout Credit refund |

**Table 31. Refund**

| Column | Data type | Key | Description | Notes |
|---|---|---|---|---|
| REFUND_ID | int | PK | Unique refund ID | |
| RES_ID | int | FK | Reservation refunded | References RESERVATION.RES_ID |
| REFUND_TYPE | enum | | Reason | Allowed values: Cancellation, Checkout Credit. At most one Cancellation refund per reservation |
| REFUND_AMT | decimal | | Amount refunded | Precision (8,2); cannot be negative. The amount refunded at that time |
| REFUND_DATE | date | | Date refunded | |

**Table 32. Staff**

| Column | Data type | Key | Description | Notes |
|---|---|---|---|---|
| STAFF_ID | int | PK | Unique staff ID | |
| PASS | varchar(255) | | Hashed password of the employee | Stored only as a salted hash (for example bcrypt); never stored or shown as plain text |
| U_NAME | varchar(30) | | Username of the employee | Unique |
| NAME | varchar(100) | | Name of the employee | |
| ROLE | enum | | Specific role of the employee | Allowed values: Front Desk, Finance, Database Administrator |
| IS_ACTIVE | enum | | Whether the employee's account is currently active | Allowed values: Yes, No |

**Table 33. Audit Trail**

| Column | Data type | Key | Description | Notes |
|---|---|---|---|---|
| AUDIT_ID | int | PK | Unique audit ID | |
| STAFF_ID | int | FK | Staff who performed the action | References STAFF.STAFF_ID; Nullable (NULL for system-generated actions, such as crediting points, setting No-Show, or deletion) |
| ACTION | enum | | Action performed | Allowed values: UPDATE, INSERT, DELETE |
| AFF_TAB | enum | | Which table was affected by the action | Allowed values: STAFF, CANCELLATION, RESERVATION, RESERVATION_ROOM, RECEIPT, ROOM, ROOM_DETAILS, CUSTOMER, LOYALTY_ACC, PAYMENT, ADJUSTMENT_CHARGE, REFUND |
| REC_ID | varchar(50) | | Specific record ID of the table that was affected | |
| TIMESTAMP | timestamp | | Date and time that the action was performed | |
| OLD_DATA | text | | The data that was affected by the action | |
| NEW_DATA | text | | The data that replaced the old data | |
