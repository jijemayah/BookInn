<?php
require_once __DIR__ . '/includes/auth.php';
require_once __DIR__ . '/includes/functions.php';
requireRole([ROLE_ADMIN, ROLE_FRONT_DESK]);

$pdo = getDbConnection();
expireStaleHolds($pdo); // Business Rule: Hold Expiration (Pending + unpaid > 48h -> auto-cancel, release room)
$error = '';
$success = '';

// ---- Create Reservation + Reservation_Room (with overlap prevention) ----
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['create_reservation'])) {
    $cusId    = $_POST['cus_id'] ?? '';
    $roomNo   = $_POST['room_no'] ?? '';
    $checkIn  = $_POST['check_in'] ?? '';
    $checkOut = $_POST['check_out'] ?? '';

    if ($cusId === '' || $roomNo === '' || $checkIn === '' || $checkOut === '') {
        $error = 'All fields are required.';
    } elseif ($checkOut <= $checkIn) {
        $error = 'Check-out date must be after check-in date.';
    } else {
        try {
            $pdo->beginTransaction();

            // Lock the room row to prevent race conditions between concurrent bookings
            $pdo->prepare('SELECT ROOM_NO FROM ROOM WHERE ROOM_NO = :r FOR UPDATE')->execute([':r' => $roomNo]);

            if (!isRoomAvailable($pdo, (int)$roomNo, $checkIn, $checkOut)) {
                $pdo->rollBack();
                $error = 'That room is already booked for an overlapping date range. Please choose different dates or another room.';
            } else {
                $stmt = $pdo->prepare('INSERT INTO RESERVATION (CUS_ID, STAFF_ID, BOOKING_STATUS) VALUES (:c, :s, \'Pending\') RETURNING RES_ID');
                $stmt->execute([':c' => $cusId, ':s' => currentStaffId()]);
                $resId = (int)$stmt->fetchColumn();

                $stmt = $pdo->prepare('INSERT INTO RESERVATION_ROOM (RES_ID, ROOM_NO, CHECK_IN_DATE, CHECK_OUT_DATE) VALUES (:res, :room, :cin, :cout)');
                $stmt->execute([':res' => $resId, ':room' => $roomNo, ':cin' => $checkIn, ':cout' => $checkOut]);

                $pdo->commit();

                syncRoomStatus($pdo, (int)$roomNo);
                $success = "Reservation #$resId created.";
            }
        } catch (PDOException $e) {
            if ($pdo->inTransaction()) { $pdo->rollBack(); }
            $error = 'Database error: ' . $e->getMessage();
        }
    }
}

// ---- Cancel Reservation (with audit log) ----
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['cancel_reservation'])) {
    $resId  = (int)$_POST['res_id'];
    $reason = trim($_POST['reason'] ?? '');

    $stmt = $pdo->prepare("UPDATE RESERVATION SET BOOKING_STATUS = 'Cancelled' WHERE RES_ID = :id");
    $stmt->execute([':id' => $resId]);

    $stmt = $pdo->prepare('INSERT INTO CANCELLATION_LOG (RES_ID, STAFF_ID, REASON) VALUES (:id, :s, :r)');
    $stmt->execute([':id' => $resId, ':s' => currentStaffId(), ':r' => $reason ?: null]);

    // release rooms tied to this reservation
    $stmt = $pdo->prepare('SELECT ROOM_NO FROM RESERVATION_ROOM WHERE RES_ID = :id');
    $stmt->execute([':id' => $resId]);
    foreach ($stmt->fetchAll() as $row) {
        syncRoomStatus($pdo, (int)$row['ROOM_NO']);
    }

    $success = "Reservation #$resId cancelled.";
}

// ---- Mark No-Show ----
if (isset($_GET['no_show'])) {
    $resId = (int)$_GET['no_show'];
    $stmt = $pdo->prepare("UPDATE RESERVATION SET BOOKING_STATUS = 'No-Show' WHERE RES_ID = :id");
    $stmt->execute([':id' => $resId]);

    $stmt = $pdo->prepare('SELECT ROOM_NO FROM RESERVATION_ROOM WHERE RES_ID = :id');
    $stmt->execute([':id' => $resId]);
    foreach ($stmt->fetchAll() as $row) {
        syncRoomStatus($pdo, (int)$row['ROOM_NO']);
    }
    header('Location: /bookinn/reservations.php');
    exit;
}

$customers = $pdo->query("SELECT CUS_ID, CUS_NAME FROM CUSTOMER WHERE IS_ACTIVE = TRUE ORDER BY CUS_NAME")->fetchAll();
$rooms = $pdo->query("SELECT ROOM_NO, ROOM_STATUS FROM ROOM WHERE ROOM_STATUS != 'Unavailable' ORDER BY ROOM_NO")->fetchAll();

$reservations = $pdo->query("SELECT r.RES_ID, c.CUS_NAME, r.BOOKING_STATUS, r.CREATED_AT,
        STRING_AGG(rr.ROOM_NO::text, ', ' ORDER BY rr.ROOM_NO) AS rooms,
        MIN(rr.CHECK_IN_DATE) AS check_in, MAX(rr.CHECK_OUT_DATE) AS check_out
    FROM RESERVATION r
    INNER JOIN CUSTOMER c ON c.CUS_ID = r.CUS_ID
    LEFT JOIN RESERVATION_ROOM rr ON rr.RES_ID = r.RES_ID
    GROUP BY r.RES_ID
    ORDER BY r.RES_ID DESC")->fetchAll();

$pageTitle = 'Reservations';
require __DIR__ . '/includes/header.php';
?>
<h1>Reservations</h1>

<?php if ($error): ?><div class="alert alert-error"><?= h($error) ?></div><?php endif; ?>
<?php if ($success): ?><div class="alert alert-success"><?= h($success) ?></div><?php endif; ?>

<div class="form-box">
  <h3>New Reservation</h3>
  <form method="post" action="/bookinn/reservations.php">
    <label>Guest</label>
    <select name="cus_id" required>
      <option value="">-- select guest --</option>
      <?php foreach ($customers as $c): ?>
        <option value="<?= (int)$c['CUS_ID'] ?>"><?= h($c['CUS_NAME']) ?></option>
      <?php endforeach; ?>
    </select>
    <label>Room</label>
    <select name="room_no" required>
      <option value="">-- select room --</option>
      <?php foreach ($rooms as $r): ?>
        <option value="<?= (int)$r['ROOM_NO'] ?>">Room <?= (int)$r['ROOM_NO'] ?> (<?= h($r['ROOM_STATUS']) ?>)</option>
      <?php endforeach; ?>
    </select>
    <label>Check-in Date</label>
    <input type="date" name="check_in" required>
    <label>Check-out Date</label>
    <input type="date" name="check_out" required>
    <button type="submit" name="create_reservation" class="btn">Create Reservation</button>
  </form>
</div>

<h2>All Reservations</h2>
<table>
<tr><th>ID</th><th>Guest</th><th>Room(s)</th><th>Check-in</th><th>Check-out</th><th>Status</th><th>Actions</th></tr>
<?php foreach ($reservations as $r): ?>
<tr>
    <td><?= (int)$r['RES_ID'] ?></td>
    <td><?= h($r['CUS_NAME']) ?></td>
    <td><?= h($r['rooms'] ?? '-') ?></td>
    <td><?= h($r['check_in'] ?? '-') ?></td>
    <td><?= h($r['check_out'] ?? '-') ?></td>
    <td class="status-<?= str_replace(['-',' '],'',$r['BOOKING_STATUS']) ?>"><?= h($r['BOOKING_STATUS']) ?></td>
    <td>
        <?php if (in_array($r['BOOKING_STATUS'], ['Pending','Confirmed'], true)): ?>
        <form class="inline" method="post" action="/bookinn/reservations.php" onsubmit="return confirm('Cancel this reservation?');">
            <input type="hidden" name="res_id" value="<?= (int)$r['RES_ID'] ?>">
            <input type="text" name="reason" placeholder="reason (optional)" style="width:110px;">
            <button type="submit" name="cancel_reservation" class="btn btn-small btn-danger">Cancel</button>
        </form>
        <a class="btn btn-small" href="/bookinn/reservations.php?no_show=<?= (int)$r['RES_ID'] ?>"
           onclick="return confirm('Mark this reservation as No-Show?');">No-Show</a>
        <?php endif; ?>
        <a class="btn btn-small" href="/bookinn/payments.php?res_id=<?= (int)$r['RES_ID'] ?>">Payments</a>
    </td>
</tr>
<?php endforeach; ?>
</table>

<?php require __DIR__ . '/includes/footer.php'; ?>
