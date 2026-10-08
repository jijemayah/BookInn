<?php
require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/functions.php';
requireLogin();

$pdo = getDbConnection();
expireStaleHolds($pdo); // Business Rule: Hold Expiration (Pending + unpaid > 48h -> auto-cancel, release room)

$totalRooms     = (int)$pdo->query('SELECT COUNT(*) FROM ROOM')->fetchColumn();
$availableRooms = (int)$pdo->query("SELECT COUNT(*) FROM ROOM WHERE ROOM_STATUS = 'Available'")->fetchColumn();
$occupiedRooms  = (int)$pdo->query("SELECT COUNT(*) FROM ROOM WHERE ROOM_STATUS = 'Occupied'")->fetchColumn();
$activeRes      = (int)$pdo->query("SELECT COUNT(*) FROM RESERVATION WHERE BOOKING_STATUS IN ('Pending','Confirmed')")->fetchColumn();
$unpaidCount    = (int)$pdo->query("SELECT COUNT(DISTINCT RES_ID) FROM PAYMENT WHERE PAY_STATUS IN ('Unpaid','Partially Paid')")->fetchColumn();

$stmt = $pdo->query("SELECT r.RES_ID, c.CUS_NAME, r.BOOKING_STATUS, r.CREATED_AT
    FROM RESERVATION r
    INNER JOIN CUSTOMER c ON c.CUS_ID = r.CUS_ID
    ORDER BY r.CREATED_AT DESC
    LIMIT 10");
$recentReservations = $stmt->fetchAll();

$pageTitle = 'Dashboard';
require __DIR__ . '/../includes/header.php';
?>
<h1>Dashboard</h1>

<div class="stat-cards">
    <div class="stat-card"><div class="num"><?= $totalRooms ?></div><div class="label">Total Rooms</div></div>
    <div class="stat-card"><div class="num"><?= $availableRooms ?></div><div class="label">Available Rooms</div></div>
    <div class="stat-card"><div class="num"><?= $occupiedRooms ?></div><div class="label">Occupied Rooms</div></div>
    <div class="stat-card"><div class="num"><?= $activeRes ?></div><div class="label">Active Reservations</div></div>
    <div class="stat-card"><div class="num"><?= $unpaidCount ?></div><div class="label">Unpaid / Partial Reservations</div></div>
</div>

<h2>Recent Reservations</h2>
<table>
<tr><th>Res. ID</th><th>Guest</th><th>Status</th><th>Created</th></tr>
<?php foreach ($recentReservations as $r): ?>
<tr>
    <td><?= h((string)$r['RES_ID']) ?></td>
    <td><?= h($r['CUS_NAME']) ?></td>
    <td class="status-<?= str_replace(['-',' '],'',$r['BOOKING_STATUS']) ?>"><?= h($r['BOOKING_STATUS']) ?></td>
    <td><?= h($r['CREATED_AT']) ?></td>
</tr>
<?php endforeach; ?>
<?php if (!$recentReservations): ?>
<tr><td colspan="4">No reservations yet.</td></tr>
<?php endif; ?>
</table>

<p>
  <a class="btn" href="/reservations?action=new">+ New Reservation</a>
  <a class="btn" href="/customers?action=new">+ New Guest</a>
</p>

<?php require __DIR__ . '/../includes/footer.php'; ?>
