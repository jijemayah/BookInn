-- =====================================================================
-- BookInn — migration 0005: schema for SRS v2 (docs/SRS_v2.md §4.3, §4.4).
--
--   1. bookinn.hotel_today(): "today" in Asia/Manila (SRS §3.3 Dates and Times).
--   2. Data conversion of existing rows (see docs/SRS_AUDIT.md, B-section):
--        a. Booked reservations whose latest check-out has passed → Completed
--           (what the old daily job would have done; avoids No-Show emails
--           for stays recorded under the old rules).
--        b. Still-Booked reservations: points earned at payment under the old
--           rule are taken back and PTS_EARN is recalculated as PAY_AMT ÷ 100;
--           they are credited when the reservation becomes Completed.
--        c. Every existing payment becomes PAY_TYPE = 'Initial'.
--   3. PAYMENT: PAY_TYPE; one Initial and at most one Checkout per reservation.
--   4. RESERVATION_ROOM: ACTUAL_CHECK_IN, ACTUAL_CHECK_OUT.
--   5. New tables ADJUSTMENT_CHARGE and REFUND.
--   6. Delete rules of Table 20 (cascade from RESERVATION / PAYMENT), with a
--      guard so that only the retention purge removes dependent records.
--   7. ROOM_DETAILS.ROOM_PRICE is fixed and may be 0; a room's type is locked
--      once the room has any reservation.
--   8. Double booking counts Booked and Checked-In reservations; a room that
--      is checked in stays unavailable until it is checked out.
--   9. Reservation status rules and points credited at Completed.
--  10. Overdue view (computed, never stored).
--  11. Daily job functions: No-Show, Completed, retention purge.
--  12. Audit triggers and Row Level Security for the new objects.
--
-- Migrations 0001–0003 are not edited.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Hotel date. The setting bookinn.today (transaction-local) lets the
--    daily job and the tests evaluate the rules for a given day.
-- ---------------------------------------------------------------------
CREATE FUNCTION bookinn.hotel_today() RETURNS date
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(NULLIF(current_setting('bookinn.today', true), '')::date,
                    (now() AT TIME ZONE 'Asia/Manila')::date)
$$;

-- ---------------------------------------------------------------------
-- 2. Data conversion (runs before the new rules and triggers exist; every
--    change is written to the audit trail with STAFF_ID = NULL).
-- ---------------------------------------------------------------------
-- 2a. Finished stays still marked Booked → Completed.
UPDATE bookinn.reservation r
   SET booking_status = 'Completed'
 WHERE r.booking_status = 'Booked'
   AND (SELECT max(rr.check_out_date) FROM bookinn.reservation_room rr WHERE rr.res_id = r.res_id) < bookinn.hotel_today();

-- 2b. Points of still-Booked reservations: take back what was credited at
--     payment (never below 0) and store the SRS v2 amount (÷ 100).
WITH credited AS (
    SELECT l.lyl_id, sum(p.pts_earn) AS pts
      FROM bookinn.payment p
      JOIN bookinn.reservation r  ON r.res_id = p.res_id
      JOIN bookinn.loyalty_acc l  ON l.cus_id = r.cus_id
     WHERE r.booking_status = 'Booked' AND p.pts_earn > 0
     GROUP BY l.lyl_id
)
UPDATE bookinn.loyalty_acc l
   SET total_pts = l.total_pts - LEAST(l.total_pts, c.pts)
  FROM credited c
 WHERE c.lyl_id = l.lyl_id;

UPDATE bookinn.payment p
   SET pts_earn = floor(p.pay_amt / 100)::int
  FROM bookinn.reservation r
 WHERE r.res_id = p.res_id AND r.booking_status = 'Booked' AND p.pts_earn > 0;

-- ---------------------------------------------------------------------
-- 3. PAYMENT.PAY_TYPE (2c: existing rows become 'Initial' via the default)
-- ---------------------------------------------------------------------
ALTER TABLE bookinn.payment ADD COLUMN pay_type bookinn.pay_type_t NOT NULL DEFAULT 'Initial';
ALTER TABLE bookinn.payment DROP CONSTRAINT payment_res_uq;
CREATE UNIQUE INDEX payment_initial_uq  ON bookinn.payment (res_id) WHERE pay_type = 'Initial';
CREATE UNIQUE INDEX payment_checkout_uq ON bookinn.payment (res_id) WHERE pay_type = 'Checkout';
CREATE INDEX payment_res_idx ON bookinn.payment (res_id);
ALTER TABLE bookinn.payment ADD CONSTRAINT payment_checkout_no_discount_chk
    CHECK (pay_type = 'Initial' OR (discount_type = 'NONE' AND pts_spend = 0));   -- "Checkout payments use NONE"

-- ---------------------------------------------------------------------
-- 4. RESERVATION_ROOM check-in and check-out events (Asia/Manila time)
-- ---------------------------------------------------------------------
ALTER TABLE bookinn.reservation_room ADD COLUMN actual_check_in  timestamp;
ALTER TABLE bookinn.reservation_room ADD COLUMN actual_check_out timestamp;
ALTER TABLE bookinn.reservation_room ADD CONSTRAINT reservation_room_actual_in_chk
    CHECK (actual_check_in IS NULL OR actual_check_in >= check_in_date::timestamp);      -- not before CHECK_IN_DATE
ALTER TABLE bookinn.reservation_room ADD CONSTRAINT reservation_room_actual_out_chk
    CHECK (actual_check_out IS NULL OR (actual_check_in IS NOT NULL AND actual_check_out > actual_check_in));

-- ---------------------------------------------------------------------
-- 5. New tables
-- ---------------------------------------------------------------------
CREATE TABLE bookinn.adjustment_charge (
    charge_id    int GENERATED BY DEFAULT AS IDENTITY (START WITH 7001) PRIMARY KEY,
    res_id       int NOT NULL
                 REFERENCES bookinn.reservation (res_id) ON DELETE CASCADE ON UPDATE RESTRICT,
    res_room_id  int
                 REFERENCES bookinn.reservation_room (res_room_id) ON DELETE SET NULL ON UPDATE RESTRICT,
    charge_type  bookinn.charge_type_t NOT NULL,
    ext_from     date,
    ext_to       date,
    charge_amt   decimal(8, 2) NOT NULL,
    pay_status   bookinn.charge_pay_status_t NOT NULL DEFAULT 'Unpaid',
    pay_id       int
                 REFERENCES bookinn.payment (pay_id) ON DELETE SET NULL ON UPDATE RESTRICT,
    -- Modification: belongs to the reservation only. Extension: dates, amount >= 0.
    -- (RES_ROOM_ID of an Extension is required on insert by a trigger, not here,
    --  because ON DELETE SET NULL must be able to clear it during the purge.)
    CONSTRAINT adjustment_charge_type_chk CHECK (
        (charge_type = 'Modification' AND res_room_id IS NULL AND ext_from IS NULL AND ext_to IS NULL) OR
        (charge_type = 'Extension' AND ext_from IS NOT NULL AND ext_to IS NOT NULL AND ext_to > ext_from AND charge_amt >= 0)
    ),
    CONSTRAINT adjustment_charge_paid_chk CHECK (pay_id IS NULL OR pay_status = 'Paid')
);
CREATE INDEX adjustment_charge_res_idx  ON bookinn.adjustment_charge (res_id);
CREATE INDEX adjustment_charge_room_idx ON bookinn.adjustment_charge (res_room_id);
CREATE INDEX adjustment_charge_pay_idx  ON bookinn.adjustment_charge (pay_id);

CREATE TABLE bookinn.refund (
    refund_id    int GENERATED BY DEFAULT AS IDENTITY (START WITH 8001) PRIMARY KEY,
    res_id       int NOT NULL
                 REFERENCES bookinn.reservation (res_id) ON DELETE CASCADE ON UPDATE RESTRICT,
    refund_type  bookinn.refund_type_t NOT NULL,
    refund_amt   decimal(8, 2) NOT NULL,
    refund_date  date NOT NULL,
    CONSTRAINT refund_amt_chk CHECK (refund_amt >= 0)
);
CREATE INDEX refund_res_idx ON bookinn.refund (res_id);
-- "At most one Cancellation refund per reservation"; a reservation also has
-- at most one check-out settlement, so at most one Checkout Credit.
CREATE UNIQUE INDEX refund_cancellation_uq    ON bookinn.refund (res_id) WHERE refund_type = 'Cancellation';
CREATE UNIQUE INDEX refund_checkout_credit_uq ON bookinn.refund (res_id) WHERE refund_type = 'Checkout Credit';

-- Charge integrity that needs other tables.
CREATE FUNCTION bookinn.adjustment_charge_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    room_res  int;
    price     decimal(8, 2);
    pay       record;
BEGIN
    IF NEW.res_room_id IS NOT NULL THEN
        SELECT rr.res_id, d.room_price INTO room_res, price
          FROM bookinn.reservation_room rr
          JOIN bookinn.room ro        ON ro.room_no = rr.room_no
          JOIN bookinn.room_details d ON d.room_type_id = ro.room_type_id
         WHERE rr.res_room_id = NEW.res_room_id;
        IF room_res IS DISTINCT FROM NEW.res_id THEN
            RAISE EXCEPTION 'Reserved room #% does not belong to reservation #%.', NEW.res_room_id, NEW.res_id
                  USING ERRCODE = 'check_violation', CONSTRAINT = 'adjustment_charge_room_res';
        END IF;
    END IF;

    IF TG_OP = 'INSERT' AND NEW.charge_type = 'Extension' THEN
        IF NEW.res_room_id IS NULL THEN
            RAISE EXCEPTION 'An Extension charge must name the reserved room it extends.'
                  USING ERRCODE = 'check_violation', CONSTRAINT = 'adjustment_charge_extension_room';
        END IF;
        -- Extension amount = nights × ROOM_PRICE of the room when posted (Table 30).
        -- (Bad dates are left to adjustment_charge_type_chk, which runs after this trigger.)
        IF NEW.ext_to > NEW.ext_from AND NEW.charge_amt <> (NEW.ext_to - NEW.ext_from) * price THEN
            RAISE EXCEPTION 'Extension charge must be % night(s) × ₱% = ₱%.',
                  NEW.ext_to - NEW.ext_from, price, (NEW.ext_to - NEW.ext_from) * price
                  USING ERRCODE = 'check_violation', CONSTRAINT = 'adjustment_charge_extension_amt';
        END IF;
    END IF;

    IF NEW.pay_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.pay_id IS DISTINCT FROM OLD.pay_id) THEN
        SELECT res_id, pay_type INTO pay FROM bookinn.payment WHERE pay_id = NEW.pay_id;
        IF pay.res_id IS DISTINCT FROM NEW.res_id OR pay.pay_type IS DISTINCT FROM 'Checkout' THEN
            RAISE EXCEPTION 'A charge can only be settled by the Checkout payment of its own reservation.'
                  USING ERRCODE = 'check_violation', CONSTRAINT = 'adjustment_charge_checkout_payment';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER adjustment_charge_check
    BEFORE INSERT OR UPDATE ON bookinn.adjustment_charge
    FOR EACH ROW EXECUTE FUNCTION bookinn.adjustment_charge_check();

-- ---------------------------------------------------------------------
-- 6. Delete rules (Table 20). Constraint names are the Postgres defaults
--    created by migration 0001.
-- ---------------------------------------------------------------------
ALTER TABLE bookinn.reservation_room DROP CONSTRAINT reservation_room_res_id_fkey;
ALTER TABLE bookinn.reservation_room ADD CONSTRAINT reservation_room_res_id_fkey
    FOREIGN KEY (res_id) REFERENCES bookinn.reservation (res_id) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE bookinn.payment DROP CONSTRAINT payment_res_id_fkey;
ALTER TABLE bookinn.payment ADD CONSTRAINT payment_res_id_fkey
    FOREIGN KEY (res_id) REFERENCES bookinn.reservation (res_id) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE bookinn.receipt DROP CONSTRAINT receipt_pay_id_fkey;
ALTER TABLE bookinn.receipt ADD CONSTRAINT receipt_pay_id_fkey
    FOREIGN KEY (pay_id) REFERENCES bookinn.payment (pay_id) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE bookinn.cancellation DROP CONSTRAINT cancellation_res_id_fkey;
ALTER TABLE bookinn.cancellation ADD CONSTRAINT cancellation_res_id_fkey
    FOREIGN KEY (res_id) REFERENCES bookinn.reservation (res_id) ON DELETE CASCADE ON UPDATE RESTRICT;

-- §3.3 Admin Control: "Users cannot delete records that other records depend
-- on. Only the scheduled one-year retention purge removes a reservation
-- together with its dependent records." The cascades above exist for the
-- purge, which sets bookinn.purge = 'on'; every other delete of a record
-- that still has dependents is refused like a RESTRICT foreign key.
CREATE FUNCTION bookinn.guard_dependent_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    dep text;
BEGIN
    IF current_setting('bookinn.purge', true) = 'on' THEN
        RETURN OLD;
    END IF;
    IF TG_TABLE_NAME = 'reservation' THEN
        dep := CASE
            WHEN EXISTS (SELECT 1 FROM bookinn.reservation_room  WHERE res_id = OLD.res_id) THEN 'reservation_room'
            WHEN EXISTS (SELECT 1 FROM bookinn.payment           WHERE res_id = OLD.res_id) THEN 'payment'
            WHEN EXISTS (SELECT 1 FROM bookinn.cancellation      WHERE res_id = OLD.res_id) THEN 'cancellation'
            WHEN EXISTS (SELECT 1 FROM bookinn.adjustment_charge WHERE res_id = OLD.res_id) THEN 'adjustment_charge'
            WHEN EXISTS (SELECT 1 FROM bookinn.refund            WHERE res_id = OLD.res_id) THEN 'refund'
        END;
    ELSIF TG_TABLE_NAME = 'reservation_room' THEN
        dep := CASE WHEN EXISTS (SELECT 1 FROM bookinn.adjustment_charge WHERE res_room_id = OLD.res_room_id) THEN 'adjustment_charge' END;
    ELSIF TG_TABLE_NAME = 'payment' THEN
        dep := CASE
            WHEN EXISTS (SELECT 1 FROM bookinn.receipt           WHERE pay_id = OLD.pay_id) THEN 'receipt'
            WHEN EXISTS (SELECT 1 FROM bookinn.adjustment_charge WHERE pay_id = OLD.pay_id) THEN 'adjustment_charge'
        END;
    END IF;
    IF dep IS NOT NULL THEN
        RAISE EXCEPTION 'update or delete on table "%" violates the delete rule: record is still referenced', TG_TABLE_NAME
              USING ERRCODE = 'foreign_key_violation',
                    DETAIL = format('Key is still referenced from table "%s".', dep);
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER reservation_guard_delete      BEFORE DELETE ON bookinn.reservation      FOR EACH ROW EXECUTE FUNCTION bookinn.guard_dependent_delete();
CREATE TRIGGER reservation_room_guard_delete BEFORE DELETE ON bookinn.reservation_room FOR EACH ROW EXECUTE FUNCTION bookinn.guard_dependent_delete();
CREATE TRIGGER payment_guard_delete          BEFORE DELETE ON bookinn.payment          FOR EACH ROW EXECUTE FUNCTION bookinn.guard_dependent_delete();

-- ---------------------------------------------------------------------
-- 7. Room rules (§3.3 Room Type Rule; Table 26)
-- ---------------------------------------------------------------------
ALTER TABLE bookinn.room_details DROP CONSTRAINT room_details_price_chk;
ALTER TABLE bookinn.room_details ADD CONSTRAINT room_details_price_chk CHECK (room_price >= 0);   -- "cannot be negative"

CREATE FUNCTION bookinn.room_details_price_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.room_price IS DISTINCT FROM OLD.room_price THEN
        RAISE EXCEPTION 'ROOM_PRICE is fixed when the room type is created. Create a new room type for a different rate.'
              USING ERRCODE = 'check_violation', CONSTRAINT = 'room_price_fixed';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER room_details_price_fixed
    BEFORE UPDATE OF room_price ON bookinn.room_details
    FOR EACH ROW EXECUTE FUNCTION bookinn.room_details_price_fixed();

CREATE FUNCTION bookinn.room_type_locked() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.room_type_id IS DISTINCT FROM OLD.room_type_id
       AND EXISTS (SELECT 1 FROM bookinn.reservation_room WHERE room_no = OLD.room_no) THEN
        RAISE EXCEPTION 'Room %''s type cannot be changed because the room already has reservations.', OLD.room_no
              USING ERRCODE = 'check_violation', CONSTRAINT = 'room_type_locked';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER room_type_locked
    BEFORE UPDATE OF room_type_id ON bookinn.room
    FOR EACH ROW EXECUTE FUNCTION bookinn.room_type_locked();

-- ---------------------------------------------------------------------
-- 8. Double booking (§3.3 Room Availability, Double-Booking Prevention).
--    A reserved room blocks [check-in, check-out) while its reservation is
--    Booked or Checked-In and the room is not checked out yet. A room that
--    is checked in and past its check-out date stays blocked through today.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bookinn.assert_room_free(p_room int, p_in date, p_out date, p_res int, p_exclude int)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    clash record;
BEGIN
    PERFORM 1 FROM bookinn.room WHERE room_no = p_room FOR UPDATE;
    SELECT rr.res_id, rr.check_in_date, rr.check_out_date, rr.actual_check_in INTO clash
      FROM bookinn.reservation_room rr
      JOIN bookinn.reservation r ON r.res_id = rr.res_id
     WHERE rr.room_no = p_room
       AND r.booking_status IN ('Booked', 'Checked-In')
       AND rr.actual_check_out IS NULL
       AND rr.res_id <> p_res
       AND rr.res_room_id <> COALESCE(p_exclude, -1)
       AND rr.check_in_date < p_out
       AND CASE WHEN rr.actual_check_in IS NOT NULL
                THEN GREATEST(rr.check_out_date, bookinn.hotel_today() + 1)
                ELSE rr.check_out_date END > p_in
     LIMIT 1;
    IF FOUND THEN
        IF clash.actual_check_in IS NOT NULL AND clash.check_out_date <= p_in THEN
            RAISE EXCEPTION 'Room % is still checked in (reservation #%) and has not been checked out.', p_room, clash.res_id
                  USING ERRCODE = 'exclusion_violation', CONSTRAINT = 'room_double_booking';
        END IF;
        RAISE EXCEPTION 'Room % is already booked from % to % (reservation #%).',
              p_room, clash.check_in_date, clash.check_out_date, clash.res_id
              USING ERRCODE = 'exclusion_violation', CONSTRAINT = 'room_double_booking';
    END IF;
    -- Two rows of the same reservation for the same room must not overlap either.
    PERFORM 1 FROM bookinn.reservation_room rr
     WHERE rr.res_id = p_res AND rr.room_no = p_room
       AND rr.res_room_id <> COALESCE(p_exclude, -1)
       AND rr.actual_check_out IS NULL
       AND rr.check_in_date < p_out AND rr.check_out_date > p_in;
    IF FOUND THEN
        RAISE EXCEPTION 'Room % appears twice in reservation #% for overlapping dates.', p_room, p_res
              USING ERRCODE = 'exclusion_violation', CONSTRAINT = 'room_double_booking';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION bookinn.reservation_room_no_overlap() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    st bookinn.booking_status_t;
BEGIN
    IF NEW.actual_check_out IS NOT NULL THEN
        RETURN NEW;                       -- a checked-out room no longer holds the dates
    END IF;
    SELECT booking_status INTO st FROM bookinn.reservation WHERE res_id = NEW.res_id;
    IF st IN ('Booked', 'Checked-In') THEN
        PERFORM bookinn.assert_room_free(NEW.room_no, NEW.check_in_date, NEW.check_out_date, NEW.res_id,
                                         CASE WHEN TG_OP = 'UPDATE' THEN OLD.res_room_id END);
    END IF;
    RETURN NEW;
END;
$$;

-- A reservation that becomes active again (administrator correction) must still fit.
CREATE OR REPLACE FUNCTION bookinn.reservation_rebook_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    rr record;
BEGIN
    IF NEW.booking_status IN ('Booked', 'Checked-In') AND OLD.booking_status NOT IN ('Booked', 'Checked-In') THEN
        FOR rr IN SELECT * FROM bookinn.reservation_room WHERE res_id = NEW.res_id AND actual_check_out IS NULL LOOP
            PERFORM bookinn.assert_room_free(rr.room_no, rr.check_in_date, rr.check_out_date, NEW.res_id, rr.res_room_id);
        END LOOP;
    END IF;
    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------
-- 9. Reservation status rules (Table 3, Table 23) and points (FR-11)
-- ---------------------------------------------------------------------
CREATE FUNCTION bookinn.reservation_status_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    any_in    boolean;
    in_house  boolean;
    expected  boolean;
    unpaid    boolean;
BEGIN
    IF NEW.booking_status = OLD.booking_status THEN
        RETURN NEW;
    END IF;
    SELECT bool_or(actual_check_in IS NOT NULL),
           bool_or(actual_check_in IS NOT NULL AND actual_check_out IS NULL),
           bool_or(actual_check_in IS NULL AND check_out_date >= bookinn.hotel_today())
      INTO any_in, in_house, expected
      FROM bookinn.reservation_room WHERE res_id = NEW.res_id;
    unpaid := EXISTS (SELECT 1 FROM bookinn.adjustment_charge WHERE res_id = NEW.res_id AND pay_status = 'Unpaid');

    IF NEW.booking_status = 'Checked-In' AND NOT COALESCE(any_in, false) THEN
        RAISE EXCEPTION 'Reservation #% has no checked-in room, so it cannot be Checked-In.', NEW.res_id
              USING ERRCODE = 'check_violation', CONSTRAINT = 'reservation_status_rule';
    END IF;
    IF NEW.booking_status IN ('Cancelled', 'No-Show') AND COALESCE(any_in, false) THEN
        RAISE EXCEPTION 'Reservation #% has a checked-in room, so it cannot be %.', NEW.res_id, NEW.booking_status
              USING ERRCODE = 'check_violation', CONSTRAINT = 'reservation_status_rule';
    END IF;
    IF NEW.booking_status = 'Completed' THEN
        IF COALESCE(in_house, false) THEN
            RAISE EXCEPTION 'Reservation #% still has a room checked in, so it cannot be Completed.', NEW.res_id
                  USING ERRCODE = 'check_violation', CONSTRAINT = 'reservation_status_rule';
        END IF;
        IF COALESCE(expected, false) THEN
            RAISE EXCEPTION 'Reservation #% still has a room expected to check in, so it cannot be Completed.', NEW.res_id
                  USING ERRCODE = 'check_violation', CONSTRAINT = 'reservation_status_rule';
        END IF;
        IF unpaid THEN
            RAISE EXCEPTION 'Reservation #% has Unpaid charges, so it cannot be Completed.', NEW.res_id
                  USING ERRCODE = 'check_violation', CONSTRAINT = 'reservation_status_rule';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER reservation_status_rules
    BEFORE UPDATE OF booking_status ON bookinn.reservation
    FOR EACH ROW EXECUTE FUNCTION bookinn.reservation_status_rules();

-- Earned points are credited as soon as a reservation becomes Completed
-- (at check-out or in the daily job). An administrator correction that moves
-- a reservation out of Completed takes them back.
CREATE FUNCTION bookinn.reservation_points_on_complete() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    pts int;
BEGIN
    IF (NEW.booking_status = 'Completed') = (OLD.booking_status = 'Completed') THEN
        RETURN NULL;
    END IF;
    SELECT COALESCE(sum(pts_earn), 0) INTO pts FROM bookinn.payment WHERE res_id = NEW.res_id;
    IF pts > 0 THEN
        UPDATE bookinn.loyalty_acc
           SET total_pts = total_pts + CASE WHEN NEW.booking_status = 'Completed' THEN pts ELSE -pts END
         WHERE cus_id = NEW.cus_id;
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER reservation_points_on_complete
    AFTER UPDATE OF booking_status ON bookinn.reservation
    FOR EACH ROW EXECUTE FUNCTION bookinn.reservation_points_on_complete();

-- ---------------------------------------------------------------------
-- 10. Overdue list (FR-28): computed every time it is read, never stored.
-- ---------------------------------------------------------------------
CREATE VIEW bookinn.overdue_reservation WITH (security_invoker = true) AS
SELECT r.res_id,
       r.cus_id,
       c.cus_name,
       c.cus_email,
       c.cus_mobile,
       r.booking_status,
       rm.latest_check_out,
       bookinn.hotel_today() - rm.latest_check_out AS days_overdue,
       rm.rooms_checked_in,
       ch.unpaid_charges,
       ch.unpaid_amt
  FROM bookinn.reservation r
  JOIN bookinn.customer c ON c.cus_id = r.cus_id
  JOIN LATERAL (
        SELECT max(rr.check_out_date) AS latest_check_out,
               count(*) FILTER (WHERE rr.actual_check_in IS NOT NULL AND rr.actual_check_out IS NULL)::int AS rooms_checked_in
          FROM bookinn.reservation_room rr
         WHERE rr.res_id = r.res_id) rm ON true
  JOIN LATERAL (
        SELECT count(*)::int AS unpaid_charges,
               COALESCE(sum(a.charge_amt), 0)::decimal(10, 2) AS unpaid_amt
          FROM bookinn.adjustment_charge a
         WHERE a.res_id = r.res_id AND a.pay_status = 'Unpaid') ch ON true
 WHERE rm.latest_check_out < bookinn.hotel_today()
   AND (r.booking_status = 'Checked-In' OR ch.unpaid_charges > 0);

-- ---------------------------------------------------------------------
-- 11. Daily job (§3.3 Scheduled and Automatic Actions), in this order:
--     mark_no_shows → complete_reservations → purge_expired_reservations.
--     Each sets bookinn.today so the status rules use the job's date.
-- ---------------------------------------------------------------------

-- First: Booked, latest check-out before today, no room checked in → No-Show.
-- Their Unpaid charges are Voided ("Voided when cancelled or unused").
-- Returns the reservation IDs, so the caller can email the guests after commit.
CREATE FUNCTION bookinn.mark_no_shows(p_today date) RETURNS SETOF int
LANGUAGE plpgsql AS $$
DECLARE
    ids int[];
BEGIN
    PERFORM set_config('bookinn.today', p_today::text, true);
    PERFORM set_config('bookinn.audit_reason', '', true);
    SELECT COALESCE(array_agg(r.res_id ORDER BY r.res_id), '{}') INTO ids
      FROM bookinn.reservation r
     WHERE r.booking_status = 'Booked'
       AND (SELECT max(rr.check_out_date) FROM bookinn.reservation_room rr WHERE rr.res_id = r.res_id) < p_today
       AND NOT EXISTS (SELECT 1 FROM bookinn.reservation_room rr WHERE rr.res_id = r.res_id AND rr.actual_check_in IS NOT NULL);
    IF cardinality(ids) > 0 THEN
        UPDATE bookinn.reservation SET booking_status = 'No-Show' WHERE res_id = ANY (ids);
        UPDATE bookinn.adjustment_charge SET pay_status = 'Voided' WHERE res_id = ANY (ids) AND pay_status = 'Unpaid';
    END IF;
    RETURN QUERY SELECT unnest(ids);
END;
$$;

-- Second: Checked-In with no room checked in, no room still expected and no
-- Unpaid charge → Completed (the points trigger credits the earned points).
CREATE OR REPLACE FUNCTION bookinn.complete_reservations(p_today date) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
    n int;
BEGIN
    PERFORM set_config('bookinn.today', p_today::text, true);
    PERFORM set_config('bookinn.audit_reason', '', true);
    UPDATE bookinn.reservation r
       SET booking_status = 'Completed'
     WHERE r.booking_status = 'Checked-In'
       AND NOT EXISTS (SELECT 1 FROM bookinn.reservation_room rr
                        WHERE rr.res_id = r.res_id
                          AND ((rr.actual_check_in IS NOT NULL AND rr.actual_check_out IS NULL)       -- still checked in
                               OR (rr.actual_check_in IS NULL AND rr.check_out_date >= p_today)))     -- still expected
       AND NOT EXISTS (SELECT 1 FROM bookinn.adjustment_charge a WHERE a.res_id = r.res_id AND a.pay_status = 'Unpaid');
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END;
$$;

-- Third: delete every reservation whose latest check-out is 1 year or more
-- before today, with its related records (cascade), except reservations
-- with an Unpaid charge. Customers, loyalty accounts and the audit trail are
-- kept. Idempotent.
CREATE OR REPLACE FUNCTION bookinn.purge_expired_reservations(p_today date) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
    ids int[];
BEGIN
    PERFORM set_config('bookinn.today', p_today::text, true);
    SELECT COALESCE(array_agg(x.res_id), '{}') INTO ids
      FROM (SELECT rr.res_id
              FROM bookinn.reservation_room rr
             GROUP BY rr.res_id
            HAVING (max(rr.check_out_date) + interval '1 year')::date <= p_today) x
     WHERE NOT EXISTS (SELECT 1 FROM bookinn.adjustment_charge a WHERE a.res_id = x.res_id AND a.pay_status = 'Unpaid');
    IF cardinality(ids) = 0 THEN
        RETURN 0;
    END IF;
    PERFORM set_config('bookinn.audit_reason', 'RETENTION: deleted 1 year after latest check-out (SRS 3.3)', true);
    PERFORM set_config('bookinn.purge', 'on', true);
    DELETE FROM bookinn.reservation WHERE res_id = ANY (ids);
    PERFORM set_config('bookinn.purge', '', true);
    PERFORM set_config('bookinn.audit_reason', '', true);
    RETURN cardinality(ids);
END;
$$;

-- ---------------------------------------------------------------------
-- 12. Audit triggers and Row Level Security for the new objects
-- ---------------------------------------------------------------------
CREATE TRIGGER audit_adjustment_charge AFTER INSERT OR UPDATE OR DELETE ON bookinn.adjustment_charge FOR EACH ROW EXECUTE FUNCTION bookinn.audit_row('charge_id');
CREATE TRIGGER audit_refund            AFTER INSERT OR UPDATE OR DELETE ON bookinn.refund            FOR EACH ROW EXECUTE FUNCTION bookinn.audit_row('refund_id');

ALTER TABLE bookinn.adjustment_charge ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookinn.refund            ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    r text;
BEGIN
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA bookinn FROM %I', r);      -- includes the view
            EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA bookinn FROM %I', r);
            EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA bookinn FROM %I', r);
            EXECUTE format('REVOKE USAGE ON SCHEMA bookinn FROM %I', r);
        END IF;
    END LOOP;
END;
$$;
