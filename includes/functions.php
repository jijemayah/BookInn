<?php
/**
 * BookInn - Shared business-rule helpers
 * Implements: overlap prevention, room status sync, payment status sync.
 */

require_once __DIR__ . '/db.php';

/**
 * Check whether a room is free for the given date range.
 * Excludes cancelled reservations. Optionally excludes a specific
 * RES_ROOM_ID (useful when editing an existing booking).
 *
 * Overlap rule: two ranges [inA, outA) and [inB, outB) overlap if
 * inA < outB AND inB < outA.
 */
function isRoomAvailable(PDO $pdo, int $roomNo, string $checkIn, string $checkOut, ?int $excludeResRoomId = null): bool {
    $sql = 'SELECT COUNT(*) FROM RESERVATION_ROOM rr
            INNER JOIN RESERVATION r ON r.RES_ID = rr.RES_ID
            WHERE rr.ROOM_NO = :room
              AND r.BOOKING_STATUS NOT IN (\'Cancelled\', \'No-Show\')
              AND :checkin < rr.CHECK_OUT_DATE
              AND rr.CHECK_IN_DATE < :checkout';
    $params = [':room' => $roomNo, ':checkin' => $checkIn, ':checkout' => $checkOut];

    if ($excludeResRoomId !== null) {
        $sql .= ' AND rr.RES_ROOM_ID != :exclude';
        $params[':exclude'] = $excludeResRoomId;
    }

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    return ((int)$stmt->fetchColumn()) === 0;
}

/**
 * Recalculate and persist a room's status based on today's date and its
 * active reservation_room rows. Called after booking/cancel/check-in/out changes.
 * Skips rooms manually set to 'Unavailable' (maintenance lock) unless $force.
 */
function syncRoomStatus(PDO $pdo, int $roomNo, bool $force = false): void {
    $stmt = $pdo->prepare('SELECT ROOM_STATUS FROM ROOM WHERE ROOM_NO = :room');
    $stmt->execute([':room' => $roomNo]);
    $current = $stmt->fetchColumn();

    if ($current === 'Unavailable' && !$force) {
        return; // maintenance lock stays until manually cleared
    }

    $stmt = $pdo->prepare('SELECT rr.CHECK_IN_DATE, rr.CHECK_OUT_DATE
        FROM RESERVATION_ROOM rr
        INNER JOIN RESERVATION r ON r.RES_ID = rr.RES_ID
        WHERE rr.ROOM_NO = :room
          AND r.BOOKING_STATUS NOT IN (\'Cancelled\', \'No-Show\')
          AND CURRENT_DATE < rr.CHECK_OUT_DATE
        ORDER BY rr.CHECK_IN_DATE ASC');
    $stmt->execute([':room' => $roomNo]);
    $rows = $stmt->fetchAll();

    $status = 'Available';
    foreach ($rows as $row) {
        if ($row['CHECK_IN_DATE'] <= date('Y-m-d') && date('Y-m-d') < $row['CHECK_OUT_DATE']) {
            $status = 'Occupied';
            break;
        }
        $status = 'Reserved';
    }

    $stmt = $pdo->prepare('UPDATE ROOM SET ROOM_STATUS = :status WHERE ROOM_NO = :room');
    $stmt->execute([':status' => $status, ':room' => $roomNo]);
}

/**
 * Compute a reservation's total cost (sum over its booked rooms of
 * nights * room price/day) and total paid so far (excluding refunded
 * payments). Used to enforce the Overpayment Guard business rule
 * *before* a new payment is inserted, not just as a post-hoc flag.
 *
 * Returns ['total_cost' => float, 'total_paid' => float]
 */
function getReservationBalance(PDO $pdo, int $resId): array {
    $stmt = $pdo->prepare('SELECT rr.CHECK_IN_DATE, rr.CHECK_OUT_DATE, rt.ROOM_PRICE
        FROM RESERVATION_ROOM rr
        INNER JOIN ROOM ro ON ro.ROOM_NO = rr.ROOM_NO
        INNER JOIN ROOM_TYPE rt ON rt.ROOM_TYPE_ID = ro.ROOM_TYPE_ID
        WHERE rr.RES_ID = :res');
    $stmt->execute([':res' => $resId]);
    $totalCost = 0.0;
    foreach ($stmt->fetchAll() as $row) {
        $nights = (new DateTime($row['CHECK_IN_DATE']))->diff(new DateTime($row['CHECK_OUT_DATE']))->days;
        $totalCost += $nights * (float)$row['ROOM_PRICE'];
    }

    $stmt = $pdo->prepare('SELECT COALESCE(SUM(PAY_AMT),0) FROM PAYMENT WHERE RES_ID = :res AND PAY_STATUS != \'Refunded\'');
    $stmt->execute([':res' => $resId]);
    $totalPaid = (float)$stmt->fetchColumn();

    return ['total_cost' => $totalCost, 'total_paid' => $totalPaid];
}

/**
 * Recalculate a reservation's payment status from its PAYMENT rows vs.
 * the total cost of its booked rooms, and persist to all PAYMENT rows'
 * PAY_STATUS for that reservation (denormalized status mirror requested
 * by ERD: PAYMENT.PAY_STATUS reflects the reservation's paid state).
 *
 * Overpayment itself is blocked up-front at insert time (see
 * getReservationBalance() + the check in payments.php) per the
 * Business Rule: "The total payments logged cannot exceed the total
 * reservation cost." This function no longer needs to flag overpayment
 * after the fact, since it should never occur, but still reports it
 * defensively in case of concurrent/legacy data.
 *
 * Returns an array: ['status' => string, 'total_cost' => float, 'total_paid' => float, 'overpaid' => bool]
 */
function syncPaymentStatus(PDO $pdo, int $resId): array {
    $balance = getReservationBalance($pdo, $resId);
    $totalCost = $balance['total_cost'];
    $totalPaid = $balance['total_paid'];

    $overpaid = $totalPaid > $totalCost && $totalCost > 0;

    if ($totalPaid <= 0) {
        $status = 'Unpaid';
    } elseif ($totalPaid < $totalCost) {
        $status = 'Partially Paid';
    } else {
        $status = 'Fully Paid';
    }

    $stmt = $pdo->prepare('UPDATE PAYMENT SET PAY_STATUS = :status WHERE RES_ID = :res AND PAY_STATUS != \'Refunded\'');
    $stmt->execute([':status' => $status, ':res' => $resId]);

    // Confirm booking once any payment is logged (Business Rule: Confirmation Status)
    if ($totalPaid > 0) {
        $stmt = $pdo->prepare('UPDATE RESERVATION SET BOOKING_STATUS = \'Confirmed\' WHERE RES_ID = :res AND BOOKING_STATUS = \'Pending\'');
        $stmt->execute([':res' => $resId]);
    }

    return ['status' => $status, 'total_cost' => $totalCost, 'total_paid' => $totalPaid, 'overpaid' => $overpaid];
}

function h(?string $value): string {
    return htmlspecialchars($value ?? '', ENT_QUOTES, 'UTF-8');
}

/**
 * Business Rule: Hold Expiration — "Unpaid bookings auto-expire after a
 * set grace period (e.g., 24-48 hours), instantly releasing the room
 * back into the available pool."
 *
 * Lazily sweeps Pending reservations (no payment logged, i.e. still
 * Pending rather than auto-Confirmed by syncPaymentStatus()) that were
 * created more than $graceHours ago. Each expired reservation is marked
 * Cancelled, audit-logged to CANCELLATION_LOG, and its room(s) released
 * via syncRoomStatus(). Called opportunistically at the top of pages
 * that read reservation/room state, so no external cron job is required.
 */
function expireStaleHolds(PDO $pdo, int $graceHours = 48): void {
    $stmt = $pdo->prepare("SELECT RES_ID FROM RESERVATION
        WHERE BOOKING_STATUS = 'Pending'
          AND CREATED_AT < (CURRENT_TIMESTAMP - (:hours || ' hours')::interval)");
    $stmt->execute([':hours' => $graceHours]);
    $expiredIds = array_column($stmt->fetchAll(), 'RES_ID');

    foreach ($expiredIds as $resId) {
        $resId = (int)$resId;

        $pdo->beginTransaction();
        try {
            // Re-check status under lock in case another request already handled it.
            $pdo->prepare('SELECT RES_ID FROM RESERVATION WHERE RES_ID = :id FOR UPDATE')->execute([':id' => $resId]);
            $stmt = $pdo->prepare("SELECT BOOKING_STATUS FROM RESERVATION WHERE RES_ID = :id");
            $stmt->execute([':id' => $resId]);
            if ($stmt->fetchColumn() !== 'Pending') {
                $pdo->rollBack();
                continue;
            }

            $pdo->prepare("UPDATE RESERVATION SET BOOKING_STATUS = 'Cancelled' WHERE RES_ID = :id")
                ->execute([':id' => $resId]);

            $pdo->prepare('INSERT INTO CANCELLATION_LOG (RES_ID, STAFF_ID, REASON) VALUES (:id, NULL, :r)')
                ->execute([':id' => $resId, ':r' => "Auto-expired: no payment within {$graceHours}h hold period"]);

            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) { $pdo->rollBack(); }
            continue;
        }

        $stmt = $pdo->prepare('SELECT ROOM_NO FROM RESERVATION_ROOM WHERE RES_ID = :id');
        $stmt->execute([':id' => $resId]);
        foreach ($stmt->fetchAll() as $row) {
            syncRoomStatus($pdo, (int)$row['ROOM_NO']);
        }
    }
}
