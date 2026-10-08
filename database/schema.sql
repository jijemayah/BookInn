-- ============================================================
-- BookInn Hotel Reservation System - Database Schema
-- Engine: PostgreSQL (Supabase)
-- Based on: Final ERD + Normalized Tables + CH3 System Requirements
-- ============================================================

-- NOTE: Supabase projects already provide a ready-to-use "postgres"
-- database per project, so there is no CREATE DATABASE / USE step here
-- (unlike MySQL/XAMPP). Just run this script against your Supabase
-- Postgres connection (e.g. via the Supabase SQL Editor or psql).

-- ------------------------------------------------------------
-- Drop tables (child -> parent order) for clean re-run
-- ------------------------------------------------------------
DROP TABLE IF EXISTS GENERATED_REPORT;
DROP TABLE IF EXISTS RECEIPT;
DROP TABLE IF EXISTS PAYMENT;
DROP TABLE IF EXISTS RESERVATION_ROOM;
DROP TABLE IF EXISTS RESERVATION;
DROP TABLE IF EXISTS ROOM;
DROP TABLE IF EXISTS ROOM_TYPE;
DROP TABLE IF EXISTS CUSTOMER;
DROP TABLE IF EXISTS STAFF;
DROP TABLE IF EXISTS CANCELLATION_LOG;
DROP TABLE IF EXISTS ACCESS_LOG;

-- ------------------------------------------------------------
-- NOTE on enums: PHP's PDO pgsql driver uses native prepared
-- statements by default (PDO::ATTR_EMULATE_PREPARES = false), and
-- binding plain string parameters directly into native Postgres ENUM
-- columns is a well-known pain point ("column is of type x but
-- expression is of type text"). To keep the app layer simple and
-- portable, role/status columns use VARCHAR + CHECK constraints
-- instead of CREATE TYPE ... AS ENUM.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- STAFF
-- Holds system users: Administrator, Front Desk Staff, Finance Officer
-- FR-01..FR-06, Business Rules: User Accounts & System Access
-- ------------------------------------------------------------
CREATE TABLE STAFF (
    STAFF_ID     SERIAL PRIMARY KEY,
    U_NAME       VARCHAR(50)  NOT NULL UNIQUE,
    PASS         VARCHAR(255) NOT NULL,      -- stored as password_hash()
    NAME         VARCHAR(100) NOT NULL,
    ROLE         VARCHAR(20) NOT NULL
        CHECK (ROLE IN ('Administrator','Front Desk Staff','Finance Officer')),
    IS_ACTIVE    BOOLEAN NOT NULL DEFAULT TRUE,   -- true=active, false=deactivated (retained for audit)
    CREATED_AT   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- CUSTOMER
-- FR-10..FR-12, Business Rules: Guest Records
-- ------------------------------------------------------------
CREATE TABLE CUSTOMER (
    CUS_ID       SERIAL PRIMARY KEY,
    CUS_NAME     VARCHAR(100) NOT NULL,
    CUS_EMAIL    VARCHAR(100) NOT NULL UNIQUE,
    CUS_MOBILE   VARCHAR(20)  NOT NULL,
    VALID_ID     VARCHAR(100) DEFAULT NULL,     -- valid ID reference/number
    IS_ACTIVE    BOOLEAN NOT NULL DEFAULT TRUE, -- archived guests kept, never hard-deleted
    CREATED_AT   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- ROOM_TYPE
-- Business Rules: Room Operations - Setup Requirements
-- ------------------------------------------------------------
CREATE TABLE ROOM_TYPE (
    ROOM_TYPE_ID   SERIAL PRIMARY KEY,
    ROOM_TYPE      VARCHAR(50) NOT NULL UNIQUE,   -- e.g. Standard, Deluxe
    ROOM_PRICE     DECIMAL(10,2) NOT NULL          -- price per day
);

-- ------------------------------------------------------------
-- ROOM
-- FR-13..FR-15, Business Rules: Room Operations - Status Syncing
-- ------------------------------------------------------------
CREATE TABLE ROOM (
    ROOM_NO        INT PRIMARY KEY,
    ROOM_TYPE_ID   INT NOT NULL,
    ROOM_STATUS    VARCHAR(20) NOT NULL DEFAULT 'Available'
        CHECK (ROOM_STATUS IN ('Available','Reserved','Occupied','Unavailable')),
    CONSTRAINT FK_ROOM_ROOMTYPE FOREIGN KEY (ROOM_TYPE_ID)
        REFERENCES ROOM_TYPE(ROOM_TYPE_ID)
        ON UPDATE CASCADE ON DELETE RESTRICT
);

-- ------------------------------------------------------------
-- RESERVATION
-- FR-16..FR-20, Business Rules: Reservations
-- ------------------------------------------------------------
CREATE TABLE RESERVATION (
    RES_ID          SERIAL PRIMARY KEY,
    CUS_ID          INT NOT NULL,
    STAFF_ID        INT DEFAULT NULL,             -- staff who created/handled it
    BOOKING_STATUS  VARCHAR(20) NOT NULL DEFAULT 'Pending'
        CHECK (BOOKING_STATUS IN ('Pending','Confirmed','Cancelled','No-Show','Completed')),
    CREATED_AT      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT FK_RES_CUSTOMER FOREIGN KEY (CUS_ID)
        REFERENCES CUSTOMER(CUS_ID)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT FK_RES_STAFF FOREIGN KEY (STAFF_ID)
        REFERENCES STAFF(STAFF_ID)
        ON UPDATE CASCADE ON DELETE SET NULL
);

-- ------------------------------------------------------------
-- RESERVATION_ROOM
-- Links a reservation to one or more rooms with stay dates
-- FR-18, FR-19: room availability check + overlap prevention
-- ------------------------------------------------------------
CREATE TABLE RESERVATION_ROOM (
    RES_ROOM_ID     SERIAL PRIMARY KEY,
    RES_ID          INT NOT NULL,
    ROOM_NO         INT NOT NULL,
    CHECK_IN_DATE   DATE NOT NULL,
    CHECK_OUT_DATE  DATE NOT NULL,
    CONSTRAINT FK_RESROOM_RES FOREIGN KEY (RES_ID)
        REFERENCES RESERVATION(RES_ID)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT FK_RESROOM_ROOM FOREIGN KEY (ROOM_NO)
        REFERENCES ROOM(ROOM_NO)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT CHK_DATES CHECK (CHECK_OUT_DATE > CHECK_IN_DATE)
);

-- Overlap prevention is enforced at application layer (see reservations.php)
-- with a transaction + row lock, since this schema targets portability
-- rather than relying on Postgres-only EXCLUDE constraints.
CREATE INDEX IDX_RESROOM_ROOM_DATES ON RESERVATION_ROOM(ROOM_NO, CHECK_IN_DATE, CHECK_OUT_DATE);

-- ------------------------------------------------------------
-- PAYMENT
-- FR-21..FR-24, Business Rules: Payments & Receipts
-- ------------------------------------------------------------
CREATE TABLE PAYMENT (
    PAY_ID       SERIAL PRIMARY KEY,
    RES_ID       INT NOT NULL,
    STAFF_ID     INT DEFAULT NULL,                -- processing staff member
    PAY_METHOD   VARCHAR(20) NOT NULL
        CHECK (PAY_METHOD IN ('CASH','GCASH','CARD','BANK_TRANSFER')),
    PAY_STATUS   VARCHAR(20) NOT NULL DEFAULT 'Unpaid'
        CHECK (PAY_STATUS IN ('Unpaid','Partially Paid','Fully Paid','Refunded')),
    PAY_DATE     DATE NOT NULL,
    PAY_AMT      DECIMAL(10,2) NOT NULL,
    CONSTRAINT FK_PAY_RES FOREIGN KEY (RES_ID)
        REFERENCES RESERVATION(RES_ID)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT FK_PAY_STAFF FOREIGN KEY (STAFF_ID)
        REFERENCES STAFF(STAFF_ID)
        ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT CHK_PAY_AMT CHECK (PAY_AMT >= 0)
);

-- ------------------------------------------------------------
-- RECEIPT
-- Business Rules: Receipt Generation - traceable receipt per payment
-- ------------------------------------------------------------
CREATE TABLE RECEIPT (
    RCT_NO       SERIAL PRIMARY KEY,
    PAY_ID       INT NOT NULL UNIQUE,
    RCT_DATE     DATE NOT NULL,
    CONSTRAINT FK_RCT_PAY FOREIGN KEY (PAY_ID)
        REFERENCES PAYMENT(PAY_ID)
        ON UPDATE CASCADE ON DELETE RESTRICT
);

-- ------------------------------------------------------------
-- CANCELLATION_LOG
-- Business Rules: Cancellation Audit - timestamp, reason, staff
-- ------------------------------------------------------------
CREATE TABLE CANCELLATION_LOG (
    CANCEL_ID     SERIAL PRIMARY KEY,
    RES_ID        INT NOT NULL,
    STAFF_ID      INT DEFAULT NULL,
    REASON        VARCHAR(255) DEFAULT NULL,
    CANCELLED_AT  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT FK_CANCEL_RES FOREIGN KEY (RES_ID)
        REFERENCES RESERVATION(RES_ID)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT FK_CANCEL_STAFF FOREIGN KEY (STAFF_ID)
        REFERENCES STAFF(STAFF_ID)
        ON UPDATE CASCADE ON DELETE SET NULL
);

-- ------------------------------------------------------------
-- ACCESS_LOG
-- Business Rules: Role Permissions - log unauthorized attempts
-- ------------------------------------------------------------
CREATE TABLE ACCESS_LOG (
    LOG_ID        SERIAL PRIMARY KEY,
    STAFF_ID      INT DEFAULT NULL,
    ACTION        VARCHAR(100) NOT NULL,
    IS_AUTHORIZED BOOLEAN NOT NULL DEFAULT TRUE,
    LOGGED_AT     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT FK_ACCESSLOG_STAFF FOREIGN KEY (STAFF_ID)
        REFERENCES STAFF(STAFF_ID)
        ON UPDATE CASCADE ON DELETE SET NULL
);

-- ------------------------------------------------------------
-- GENERATED_REPORT
-- Persists report-generation audit trail (FR-27). Created up front here
-- instead of lazily via `CREATE TABLE IF NOT EXISTS` in reports.php,
-- since Supabase/Postgres roles used by the app may not have DDL rights.
-- ------------------------------------------------------------
CREATE TABLE GENERATED_REPORT (
    REPORT_ID     SERIAL PRIMARY KEY,
    STAFF_ID      INT,
    FILTERS       VARCHAR(255),
    ROW_COUNT     INT,
    GENERATED_AT  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- SEED DATA (matches the sample rows shown in the normalized tables)
-- ============================================================

INSERT INTO STAFF (U_NAME, PASS, NAME, ROLE) VALUES
('KDPALVARADO', '$2y$10$placeholderHashRunSeedPhpToSetReal', 'Keizzy Dominique Alvarado', 'Front Desk Staff'),
('JESMEDEL',    '$2y$10$placeholderHashRunSeedPhpToSetReal', 'Jody Erich Medel',          'Finance Officer'),
('ADMIN',       '$2y$10$placeholderHashRunSeedPhpToSetReal', 'System Administrator',      'Administrator');

INSERT INTO CUSTOMER (CUS_NAME, CUS_EMAIL, CUS_MOBILE) VALUES
('Juan Dela Cruz',    'jdcruz@gmail.com',      '9061234567'),
('Keizzy Alvarado',   'kdpalvarado@gmail.com', '9761234567');

INSERT INTO ROOM_TYPE (ROOM_TYPE, ROOM_PRICE) VALUES
('Standard', 1500.00),
('Deluxe',   3000.00);

INSERT INTO ROOM (ROOM_NO, ROOM_TYPE_ID, ROOM_STATUS) VALUES
(205, 1, 'Available'),
(206, 1, 'Available'),
(108, 2, 'Available');

-- Sample reservations/payments are intentionally omitted from seed data;
-- create them through the application to exercise the business-rule logic
-- (overlap checks, status sync, payment status triggers).
