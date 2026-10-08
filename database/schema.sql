-- ============================================================
-- BookInn Hotel Reservation System - Database Schema
-- Engine: MySQL (XAMPP)
-- Based on: Final ERD + Normalized Tables + CH3 System Requirements
-- ============================================================

CREATE DATABASE IF NOT EXISTS bookinn
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_general_ci;

USE bookinn;

-- ------------------------------------------------------------
-- Drop tables (child -> parent order) for clean re-run
-- ------------------------------------------------------------
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
-- STAFF
-- Holds system users: Administrator, Front Desk Staff, Finance Officer
-- FR-01..FR-06, Business Rules: User Accounts & System Access
-- ------------------------------------------------------------
CREATE TABLE STAFF (
    STAFF_ID     INT AUTO_INCREMENT PRIMARY KEY,
    U_NAME       VARCHAR(50)  NOT NULL UNIQUE,
    PASS         VARCHAR(255) NOT NULL,      -- stored as password_hash()
    NAME         VARCHAR(100) NOT NULL,
    ROLE         ENUM('Administrator','Front Desk Staff','Finance Officer') NOT NULL,
    IS_ACTIVE    TINYINT(1) NOT NULL DEFAULT 1,   -- 1=active, 0=deactivated (retained for audit)
    CREATED_AT   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- CUSTOMER
-- FR-10..FR-12, Business Rules: Guest Records
-- ------------------------------------------------------------
CREATE TABLE CUSTOMER (
    CUS_ID       INT AUTO_INCREMENT PRIMARY KEY,
    CUS_NAME     VARCHAR(100) NOT NULL,
    CUS_EMAIL    VARCHAR(100) NOT NULL UNIQUE,
    CUS_MOBILE   VARCHAR(20)  NOT NULL,
    VALID_ID     VARCHAR(100) DEFAULT NULL,     -- valid ID reference/number
    IS_ACTIVE    TINYINT(1) NOT NULL DEFAULT 1, -- archived guests kept, never hard-deleted
    CREATED_AT   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- ROOM_TYPE
-- Business Rules: Room Operations - Setup Requirements
-- ------------------------------------------------------------
CREATE TABLE ROOM_TYPE (
    ROOM_TYPE_ID   INT AUTO_INCREMENT PRIMARY KEY,
    ROOM_TYPE      VARCHAR(50) NOT NULL UNIQUE,   -- e.g. Standard, Deluxe
    ROOM_PRICE     DECIMAL(10,2) NOT NULL          -- price per day
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- ROOM
-- FR-13..FR-15, Business Rules: Room Operations - Status Syncing
-- ------------------------------------------------------------
CREATE TABLE ROOM (
    ROOM_NO        INT PRIMARY KEY,
    ROOM_TYPE_ID   INT NOT NULL,
    ROOM_STATUS    ENUM('Available','Reserved','Occupied','Unavailable') NOT NULL DEFAULT 'Available',
    CONSTRAINT FK_ROOM_ROOMTYPE FOREIGN KEY (ROOM_TYPE_ID)
        REFERENCES ROOM_TYPE(ROOM_TYPE_ID)
        ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- RESERVATION
-- FR-16..FR-20, Business Rules: Reservations
-- ------------------------------------------------------------
CREATE TABLE RESERVATION (
    RES_ID          INT AUTO_INCREMENT PRIMARY KEY,
    CUS_ID          INT NOT NULL,
    STAFF_ID        INT DEFAULT NULL,             -- staff who created/handled it
    BOOKING_STATUS  ENUM('Pending','Confirmed','Cancelled','No-Show','Completed') NOT NULL DEFAULT 'Pending',
    CREATED_AT      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT FK_RES_CUSTOMER FOREIGN KEY (CUS_ID)
        REFERENCES CUSTOMER(CUS_ID)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT FK_RES_STAFF FOREIGN KEY (STAFF_ID)
        REFERENCES STAFF(STAFF_ID)
        ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- RESERVATION_ROOM
-- Links a reservation to one or more rooms with stay dates
-- FR-18, FR-19: room availability check + overlap prevention
-- ------------------------------------------------------------
CREATE TABLE RESERVATION_ROOM (
    RES_ROOM_ID     INT AUTO_INCREMENT PRIMARY KEY,
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
) ENGINE=InnoDB;

-- Overlap prevention is enforced at application layer (see reservations.php)
-- with a transaction + row lock, since MySQL lacks native EXCLUDE constraints.
CREATE INDEX IDX_RESROOM_ROOM_DATES ON RESERVATION_ROOM(ROOM_NO, CHECK_IN_DATE, CHECK_OUT_DATE);

-- ------------------------------------------------------------
-- PAYMENT
-- FR-21..FR-24, Business Rules: Payments & Receipts
-- ------------------------------------------------------------
CREATE TABLE PAYMENT (
    PAY_ID       INT AUTO_INCREMENT PRIMARY KEY,
    RES_ID       INT NOT NULL,
    STAFF_ID     INT DEFAULT NULL,                -- processing staff member
    PAY_METHOD   ENUM('CASH','GCASH','CARD','BANK_TRANSFER') NOT NULL,
    PAY_STATUS   ENUM('Unpaid','Partially Paid','Fully Paid','Refunded') NOT NULL DEFAULT 'Unpaid',
    PAY_DATE     DATE NOT NULL,
    PAY_AMT      DECIMAL(10,2) NOT NULL,
    CONSTRAINT FK_PAY_RES FOREIGN KEY (RES_ID)
        REFERENCES RESERVATION(RES_ID)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT FK_PAY_STAFF FOREIGN KEY (STAFF_ID)
        REFERENCES STAFF(STAFF_ID)
        ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT CHK_PAY_AMT CHECK (PAY_AMT >= 0)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- RECEIPT
-- Business Rules: Receipt Generation - traceable receipt per payment
-- ------------------------------------------------------------
CREATE TABLE RECEIPT (
    RCT_NO       INT AUTO_INCREMENT PRIMARY KEY,
    PAY_ID       INT NOT NULL UNIQUE,
    RCT_DATE     DATE NOT NULL,
    CONSTRAINT FK_RCT_PAY FOREIGN KEY (PAY_ID)
        REFERENCES PAYMENT(PAY_ID)
        ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- CANCELLATION_LOG
-- Business Rules: Cancellation Audit - timestamp, reason, staff
-- ------------------------------------------------------------
CREATE TABLE CANCELLATION_LOG (
    CANCEL_ID     INT AUTO_INCREMENT PRIMARY KEY,
    RES_ID        INT NOT NULL,
    STAFF_ID      INT DEFAULT NULL,
    REASON        VARCHAR(255) DEFAULT NULL,
    CANCELLED_AT  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT FK_CANCEL_RES FOREIGN KEY (RES_ID)
        REFERENCES RESERVATION(RES_ID)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT FK_CANCEL_STAFF FOREIGN KEY (STAFF_ID)
        REFERENCES STAFF(STAFF_ID)
        ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- ACCESS_LOG
-- Business Rules: Role Permissions - log unauthorized attempts
-- ------------------------------------------------------------
CREATE TABLE ACCESS_LOG (
    LOG_ID        INT AUTO_INCREMENT PRIMARY KEY,
    STAFF_ID      INT DEFAULT NULL,
    ACTION        VARCHAR(100) NOT NULL,
    IS_AUTHORIZED TINYINT(1) NOT NULL DEFAULT 1,
    LOGGED_AT     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT FK_ACCESSLOG_STAFF FOREIGN KEY (STAFF_ID)
        REFERENCES STAFF(STAFF_ID)
        ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB;

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
