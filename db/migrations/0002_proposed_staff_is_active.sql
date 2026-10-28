-- =====================================================================
-- BookInn — migration 0002 (PROPOSED STRUCTURAL CHANGE, not in the SRS
-- data dictionary).
--
-- Why: SRS §3.1 FR-02 ("create, update, and deactivate user accounts") and
-- §3.3 "Account Deactivation: Deactivated accounts cannot log in, but the
-- system retains their historical activity for auditing" require a way to
-- deactivate staff WITHOUT deleting them. The §4.4 STAFF table has no column
-- for this, and deleting a staff row is impossible once AUDIT_TRAIL
-- references it (FK RESTRICT), which is the intended behaviour.
--
-- Change: one additive, defaulted column. Existing rows become active.
-- Rollback:  ALTER TABLE bookinn.staff DROP COLUMN is_active;
-- =====================================================================

ALTER TABLE bookinn.staff
    ADD COLUMN is_active boolean NOT NULL DEFAULT true;
