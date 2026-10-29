-- =====================================================================
-- BookInn — migration 0003: align the schema with the revised SRS
-- (29 Oct 2026) and move integrity rules into the database.
--
--   1. STAFF.IS_ACTIVE becomes enum Yes/No (data dictionary).
--   2. CANCELLATION.CANCELLED_BY is removed (data dictionary note:
--      "Every cancellation is made by the guest").
--   3. AUDIT_TRAIL: STAFF_ID nullable (system actions), REC_ID varchar(50),
--      OLD_DATA / NEW_DATA text.
--   4. Audit rows are written by triggers on every audited table.
--   5. Double booking is rejected by a trigger that locks the ROOM row.
--   6. Daily jobs: complete_reservations() and purge_expired_reservations().
--   7. Row Level Security on every table; no Data API access.
--
-- Safe on a database that already has 0001/0002 and seed data.
-- Rollback: restore from backup (the dropped CANCELLED_BY values are lost).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. STAFF.IS_ACTIVE: boolean → enum ('Yes', 'No')
-- ---------------------------------------------------------------------
CREATE TYPE bookinn.yes_no_t AS ENUM ('Yes', 'No');
ALTER TABLE bookinn.staff ALTER COLUMN is_active DROP DEFAULT;
ALTER TABLE bookinn.staff
    ALTER COLUMN is_active TYPE bookinn.yes_no_t
    USING (CASE WHEN is_active THEN 'Yes' ELSE 'No' END)::bookinn.yes_no_t;
ALTER TABLE bookinn.staff ALTER COLUMN is_active SET DEFAULT 'Yes';

-- Sign-in ignores letter case, so usernames must be unique ignoring case too.
CREATE UNIQUE INDEX staff_u_name_lower_uq ON bookinn.staff (lower(u_name));

-- ---------------------------------------------------------------------
-- 2. CANCELLATION.CANCELLED_BY removed
-- ---------------------------------------------------------------------
ALTER TABLE bookinn.cancellation DROP COLUMN cancelled_by;
DROP TYPE bookinn.cancelled_by_t;

-- ---------------------------------------------------------------------
-- 3. AUDIT_TRAIL column changes
-- ---------------------------------------------------------------------
ALTER TABLE bookinn.audit_trail ALTER COLUMN staff_id DROP NOT NULL;
ALTER TABLE bookinn.audit_trail ALTER COLUMN rec_id TYPE varchar(50) USING rec_id::text;
ALTER TABLE bookinn.audit_trail ALTER COLUMN old_data TYPE text;
ALTER TABLE bookinn.audit_trail ALTER COLUMN new_data TYPE text;
COMMENT ON COLUMN bookinn.audit_trail.staff_id IS 'NULL = system-generated action (daily jobs, seeding)';

-- ---------------------------------------------------------------------
-- 4. Trigger-based audit trail
--    The server runs  SELECT set_config('bookinn.staff_id', '<id>', true)
--    at the start of each write transaction; the value is transaction-local.
--    bookinn.audit_reason, when set, replaces OLD_DATA/NEW_DATA (used by the
--    retention job so deleted reservation data is not copied into the log).
--    bookinn.audit_off = 'on' is set only by the seed script.
-- ---------------------------------------------------------------------
CREATE FUNCTION bookinn.audit_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    o       jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
    n       jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
    pk      text  := TG_ARGV[0];
    reason  text  := NULLIF(current_setting('bookinn.audit_reason', true), '');
    sid     int   := NULLIF(current_setting('bookinn.staff_id', true), '')::int;
    od      text;
    nd      text;
BEGIN
    IF current_setting('bookinn.audit_off', true) = 'on' THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        SELECT string_agg(upper(a.attname) || '=' ||
                   CASE WHEN a.attname = 'pass' THEN '[changed]' ELSE COALESCE(o ->> a.attname, 'NULL') END, '; ' ORDER BY a.attnum),
               string_agg(upper(a.attname) || '=' ||
                   CASE WHEN a.attname = 'pass' THEN '[changed]' ELSE COALESCE(n ->> a.attname, 'NULL') END, '; ' ORDER BY a.attnum)
          INTO od, nd
          FROM pg_attribute a
         WHERE a.attrelid = TG_RELID AND a.attnum > 0 AND NOT a.attisdropped
           AND (o -> a.attname::text) IS DISTINCT FROM (n -> a.attname::text);
        IF od IS NULL THEN
            RETURN NULL;              -- nothing actually changed
        END IF;
    ELSE
        SELECT string_agg(upper(a.attname) || '=' ||
                   CASE WHEN a.attname = 'pass' THEN '[hidden]' ELSE COALESCE(COALESCE(n, o) ->> a.attname, 'NULL') END, '; ' ORDER BY a.attnum)
          INTO nd
          FROM pg_attribute a
         WHERE a.attrelid = TG_RELID AND a.attnum > 0 AND NOT a.attisdropped;
        IF TG_OP = 'DELETE' THEN
            od := nd;
            nd := NULL;
        END IF;
    END IF;

    IF reason IS NOT NULL THEN
        od := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE reason END;
        nd := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE reason END;
    END IF;

    INSERT INTO bookinn.audit_trail (staff_id, action, aff_tab, rec_id, old_data, new_data)
    VALUES (sid, TG_OP::bookinn.audit_action_t, upper(TG_TABLE_NAME)::bookinn.aff_tab_t,
            COALESCE(n, o) ->> pk, od, nd);
    RETURN NULL;
END;
$$;

CREATE TRIGGER audit_customer         AFTER INSERT OR UPDATE OR DELETE ON bookinn.customer         FOR EACH ROW EXECUTE FUNCTION bookinn.audit_row('cus_id');
CREATE TRIGGER audit_loyalty_acc      AFTER INSERT OR UPDATE OR DELETE ON bookinn.loyalty_acc      FOR EACH ROW EXECUTE FUNCTION bookinn.audit_row('lyl_id');
CREATE TRIGGER audit_room_details     AFTER INSERT OR UPDATE OR DELETE ON bookinn.room_details     FOR EACH ROW EXECUTE FUNCTION bookinn.audit_row('room_type_id');
CREATE TRIGGER audit_room             AFTER INSERT OR UPDATE OR DELETE ON bookinn.room             FOR EACH ROW EXECUTE FUNCTION bookinn.audit_row('room_no');
CREATE TRIGGER audit_reservation      AFTER INSERT OR UPDATE OR DELETE ON bookinn.reservation      FOR EACH ROW EXECUTE FUNCTION bookinn.audit_row('res_id');
CREATE TRIGGER audit_reservation_room AFTER INSERT OR UPDATE OR DELETE ON bookinn.reservation_room FOR EACH ROW EXECUTE FUNCTION bookinn.audit_row('res_room_id');
CREATE TRIGGER audit_payment          AFTER INSERT OR UPDATE OR DELETE ON bookinn.payment          FOR EACH ROW EXECUTE FUNCTION bookinn.audit_row('pay_id');
CREATE TRIGGER audit_receipt          AFTER INSERT OR UPDATE OR DELETE ON bookinn.receipt          FOR EACH ROW EXECUTE FUNCTION bookinn.audit_row('rct_no');
CREATE TRIGGER audit_cancellation     AFTER INSERT OR UPDATE OR DELETE ON bookinn.cancellation     FOR EACH ROW EXECUTE FUNCTION bookinn.audit_row('cancel_id');
CREATE TRIGGER audit_staff            AFTER INSERT OR UPDATE OR DELETE ON bookinn.staff            FOR EACH ROW EXECUTE FUNCTION bookinn.audit_row('staff_id');

-- ---------------------------------------------------------------------
-- 5. Double-booking prevention (FR-15, FR-16, §3.3)
--    A room is unavailable for [check_in, check_out) while another
--    reservation that holds it is 'Booked'. Locking the ROOM row serialises
--    concurrent bookings of the same room, so two transactions cannot both
--    pass the overlap check.
-- ---------------------------------------------------------------------
CREATE FUNCTION bookinn.assert_room_free(p_room int, p_in date, p_out date, p_res int, p_exclude int)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    clash record;
BEGIN
    PERFORM 1 FROM bookinn.room WHERE room_no = p_room FOR UPDATE;
    SELECT rr.res_id, rr.check_in_date, rr.check_out_date INTO clash
      FROM bookinn.reservation_room rr
      JOIN bookinn.reservation r ON r.res_id = rr.res_id
     WHERE rr.room_no = p_room
       AND r.booking_status = 'Booked'
       AND rr.res_id <> p_res
       AND rr.res_room_id <> COALESCE(p_exclude, -1)
       AND rr.check_in_date  < p_out
       AND rr.check_out_date > p_in
     LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'Room % is already booked from % to % (reservation #%).',
              p_room, clash.check_in_date, clash.check_out_date, clash.res_id
              USING ERRCODE = 'exclusion_violation', CONSTRAINT = 'room_double_booking';
    END IF;
    -- Two rows of the same reservation for the same room must not overlap either.
    PERFORM 1 FROM bookinn.reservation_room rr
     WHERE rr.res_id = p_res AND rr.room_no = p_room
       AND rr.res_room_id <> COALESCE(p_exclude, -1)
       AND rr.check_in_date < p_out AND rr.check_out_date > p_in;
    IF FOUND THEN
        RAISE EXCEPTION 'Room % appears twice in reservation #% for overlapping dates.', p_room, p_res
              USING ERRCODE = 'exclusion_violation', CONSTRAINT = 'room_double_booking';
    END IF;
END;
$$;

CREATE FUNCTION bookinn.reservation_room_no_overlap() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    st bookinn.booking_status_t;
BEGIN
    SELECT booking_status INTO st FROM bookinn.reservation WHERE res_id = NEW.res_id;
    IF st = 'Booked' THEN
        PERFORM bookinn.assert_room_free(NEW.room_no, NEW.check_in_date, NEW.check_out_date, NEW.res_id,
                                         CASE WHEN TG_OP = 'UPDATE' THEN OLD.res_room_id END);
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER reservation_room_no_overlap
    BEFORE INSERT OR UPDATE OF room_no, check_in_date, check_out_date, res_id ON bookinn.reservation_room
    FOR EACH ROW EXECUTE FUNCTION bookinn.reservation_room_no_overlap();

-- A Cancelled/Completed reservation that becomes Booked again must still fit.
CREATE FUNCTION bookinn.reservation_rebook_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    rr record;
BEGIN
    IF NEW.booking_status = 'Booked' AND OLD.booking_status <> 'Booked' THEN
        FOR rr IN SELECT * FROM bookinn.reservation_room WHERE res_id = NEW.res_id LOOP
            PERFORM bookinn.assert_room_free(rr.room_no, rr.check_in_date, rr.check_out_date, NEW.res_id, rr.res_room_id);
        END LOOP;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER reservation_rebook_check
    BEFORE UPDATE OF booking_status ON bookinn.reservation
    FOR EACH ROW EXECUTE FUNCTION bookinn.reservation_rebook_check();

-- ---------------------------------------------------------------------
-- 6. Daily jobs (run by Vercel Cron via /api/cron/maintenance, or pg_cron)
-- ---------------------------------------------------------------------

-- §3.3 Reservation Completion: Booked → Completed on the day after the
-- latest check-out date. Returns the number of reservations updated.
CREATE FUNCTION bookinn.complete_reservations(p_today date) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
    n int;
BEGIN
    PERFORM set_config('bookinn.audit_reason', '', true);
    UPDATE bookinn.reservation r
       SET booking_status = 'Completed'
     WHERE r.booking_status = 'Booked'
       AND (SELECT max(rr.check_out_date) FROM bookinn.reservation_room rr WHERE rr.res_id = r.res_id) < p_today;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END;
$$;

-- §1.4 / §3.3 Data Retention: one year after a reservation's latest
-- check-out date, delete the reservation with its reserved rooms, payment,
-- receipt and cancellation. Customers and loyalty accounts are kept.
-- Idempotent: a second run on the same day deletes nothing.
CREATE FUNCTION bookinn.purge_expired_reservations(p_today date) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
    ids int[];
BEGIN
    SELECT COALESCE(array_agg(res_id), '{}') INTO ids
      FROM (SELECT rr.res_id
              FROM bookinn.reservation_room rr
             GROUP BY rr.res_id
            HAVING (max(rr.check_out_date) + interval '1 year')::date <= p_today) x;
    IF cardinality(ids) = 0 THEN
        RETURN 0;
    END IF;
    PERFORM set_config('bookinn.audit_reason', 'RETENTION: deleted 1 year after latest check-out (SRS 3.3)', true);
    DELETE FROM bookinn.receipt      WHERE pay_id IN (SELECT pay_id FROM bookinn.payment WHERE res_id = ANY (ids));
    DELETE FROM bookinn.payment      WHERE res_id = ANY (ids);
    DELETE FROM bookinn.cancellation WHERE res_id = ANY (ids);
    DELETE FROM bookinn.reservation_room WHERE res_id = ANY (ids);
    DELETE FROM bookinn.reservation  WHERE res_id = ANY (ids);
    PERFORM set_config('bookinn.audit_reason', '', true);
    RETURN cardinality(ids);
END;
$$;

-- ---------------------------------------------------------------------
-- 7. Row Level Security
--    The app connects as the table owner (server-side only). RLS is enabled
--    with no policies, so the Supabase anon/authenticated roles see nothing
--    even if schema bookinn is ever exposed through the Data API.
-- ---------------------------------------------------------------------
ALTER TABLE bookinn.customer         ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookinn.loyalty_acc      ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookinn.room_details     ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookinn.room             ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookinn.reservation      ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookinn.reservation_room ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookinn.payment          ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookinn.receipt          ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookinn.cancellation     ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookinn.staff            ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookinn.audit_trail      ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    r text;
BEGIN
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA bookinn FROM %I', r);
            EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA bookinn FROM %I', r);
            EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA bookinn FROM %I', r);
            EXECUTE format('REVOKE USAGE ON SCHEMA bookinn FROM %I', r);
        END IF;
    END LOOP;
END;
$$;
