<?php
require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/functions.php';
requireRole([ROLE_ADMIN, ROLE_FINANCE]); // FR-28, FR-30: reports restricted to admins/finance

$pdo = getDbConnection();

$dateFrom = $_GET['date_from'] ?? '';
$dateTo   = $_GET['date_to'] ?? '';
$status   = $_GET['status'] ?? '';

// Reports only pull from finalized/active/completed bookings (Business Rule: Clean Data)
$sql = "SELECT r.RES_ID, c.CUS_NAME, r.BOOKING_STATUS,
        STRING_AGG(rr.ROOM_NO::text, ', ' ORDER BY rr.ROOM_NO) AS rooms,
        MIN(rr.CHECK_IN_DATE) AS check_in, MAX(rr.CHECK_OUT_DATE) AS check_out,
        COALESCE(SUM(CASE WHEN p.PAY_STATUS != 'Refunded' THEN p.PAY_AMT ELSE 0 END), 0) AS total_paid
    FROM RESERVATION r
    INNER JOIN CUSTOMER c ON c.CUS_ID = r.CUS_ID
    LEFT JOIN RESERVATION_ROOM rr ON rr.RES_ID = r.RES_ID
    LEFT JOIN PAYMENT p ON p.RES_ID = r.RES_ID
    WHERE r.BOOKING_STATUS IN ('Confirmed','Completed','Cancelled','No-Show')";
$params = [];

if ($dateFrom !== '') {
    $sql .= ' AND rr.CHECK_IN_DATE >= :from';
    $params[':from'] = $dateFrom;
}
if ($dateTo !== '') {
    $sql .= ' AND rr.CHECK_OUT_DATE <= :to';
    $params[':to'] = $dateTo;
}
if ($status !== '') {
    $sql .= ' AND r.BOOKING_STATUS = :status';
    $params[':status'] = $status;
}
$sql .= ' GROUP BY r.RES_ID ORDER BY r.RES_ID DESC';

$stmt = $pdo->prepare($sql);
$stmt->execute($params);
$rows = $stmt->fetchAll();

$totalRevenue = array_sum(array_column($rows, 'total_paid'));

// Persist this generated report for record-keeping (FR-27)
try {
    $pdo->exec("CREATE TABLE IF NOT EXISTS GENERATED_REPORT (
        REPORT_ID SERIAL PRIMARY KEY,
        STAFF_ID INT,
        FILTERS VARCHAR(255),
        ROW_COUNT INT,
        GENERATED_AT TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )");
    $stmt = $pdo->prepare('INSERT INTO GENERATED_REPORT (STAFF_ID, FILTERS, ROW_COUNT) VALUES (:s, :f, :c)');
    $stmt->execute([
        ':s' => currentStaffId(),
        ':f' => "from=$dateFrom;to=$dateTo;status=$status",
        ':c' => count($rows),
    ]);
} catch (Throwable $e) {
    // non-fatal
}

$pageTitle = 'Reports';
require __DIR__ . '/../includes/header.php';
?>
<h1>Reports</h1>

<div class="form-box">
  <h3>Filter</h3>
  <form method="get" action="/reports">
    <label>Check-in From</label>
    <input type="date" name="date_from" value="<?= h($dateFrom) ?>">
    <label>Check-out To</label>
    <input type="date" name="date_to" value="<?= h($dateTo) ?>">
    <label>Booking Status</label>
    <select name="status">
      <option value="">-- any --</option>
      <?php foreach (['Confirmed','Completed','Cancelled','No-Show'] as $s): ?>
        <option value="<?= h($s) ?>" <?= $status === $s ? 'selected' : '' ?>><?= h($s) ?></option>
      <?php endforeach; ?>
    </select>
    <button type="submit" class="btn">Apply Filters</button>
  </form>
</div>

<div class="stat-cards">
    <div class="stat-card"><div class="num"><?= count($rows) ?></div><div class="label">Reservations Matched</div></div>
    <div class="stat-card"><div class="num">₱<?= h(number_format($totalRevenue,2)) ?></div><div class="label">Total Revenue (non-refunded)</div></div>
</div>

<table>
<tr><th>Res. ID</th><th>Guest</th><th>Room(s)</th><th>Check-in</th><th>Check-out</th><th>Status</th><th>Total Paid</th></tr>
<?php foreach ($rows as $r): ?>
<tr>
    <td><?= (int)$r['RES_ID'] ?></td>
    <td><?= h($r['CUS_NAME']) ?></td>
    <td><?= h($r['rooms'] ?? '-') ?></td>
    <td><?= h($r['check_in'] ?? '-') ?></td>
    <td><?= h($r['check_out'] ?? '-') ?></td>
    <td class="status-<?= str_replace(['-',' '],'',$r['BOOKING_STATUS']) ?>"><?= h($r['BOOKING_STATUS']) ?></td>
    <td>₱<?= h(number_format((float)$r['total_paid'],2)) ?></td>
</tr>
<?php endforeach; ?>
<?php if (!$rows): ?>
<tr><td colspan="7">No records match the selected filters.</td></tr>
<?php endif; ?>
</table>

<?php require __DIR__ . '/../includes/footer.php'; ?>
