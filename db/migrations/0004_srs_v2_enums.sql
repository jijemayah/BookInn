-- =====================================================================
-- BookInn — migration 0004: enum values for SRS v2 (docs/SRS_v2.md).
--
-- New enum values cannot be used in the same transaction that adds them,
-- and each migration file runs in its own transaction, so the values are
-- added here and used from 0005 on.
--
--   RESERVATION.BOOKING_STATUS  + Checked-In, No-Show        (Table 23)
--   AUDIT_TRAIL.AFF_TAB         + ADJUSTMENT_CHARGE, REFUND  (Table 33)
--   PAYMENT.PAY_TYPE            Initial, Checkout            (Table 27)
--   ADJUSTMENT_CHARGE.CHARGE_TYPE  Extension, Modification   (Table 30)
--   ADJUSTMENT_CHARGE.PAY_STATUS   Unpaid, Paid, Voided      (Table 30)
--   REFUND.REFUND_TYPE          Cancellation, Checkout Credit (Table 31)
-- =====================================================================

ALTER TYPE bookinn.booking_status_t ADD VALUE IF NOT EXISTS 'Checked-In' AFTER 'Booked';
ALTER TYPE bookinn.booking_status_t ADD VALUE IF NOT EXISTS 'No-Show' AFTER 'Cancelled';

ALTER TYPE bookinn.aff_tab_t ADD VALUE IF NOT EXISTS 'ADJUSTMENT_CHARGE';
ALTER TYPE bookinn.aff_tab_t ADD VALUE IF NOT EXISTS 'REFUND';

CREATE TYPE bookinn.pay_type_t          AS ENUM ('Initial', 'Checkout');
CREATE TYPE bookinn.charge_type_t       AS ENUM ('Extension', 'Modification');
CREATE TYPE bookinn.charge_pay_status_t AS ENUM ('Unpaid', 'Paid', 'Voided');
CREATE TYPE bookinn.refund_type_t       AS ENUM ('Cancellation', 'Checkout Credit');
