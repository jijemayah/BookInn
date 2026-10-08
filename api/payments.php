<?php
require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/functions.php';
requireRole([ROLE_ADMIN, ROLE_FINANCE, ROLE_FRONT_DESK]);

$pdo = getDbConnection();
$error = '';
$success = '';

// ---- Record Payment ----
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['add_payment'])) {
    $resId  = $_POST['res_id'] ?? '';
    $method = $_POST['pay_method'] ?? '';
    $amt    = $_POST['pay_amt'] ?? '';
    $date   = $_POST['pay_date'] ?? date('Y-m-d');

    if ($resId === '' || $method === '' || $amt === '' || !is_numeric($amt) || (float)$amt <= 0) {
        $error = 'Reservation, method, and a positive amount are required.';
    } else {
        try {
            $pdo->beginTransaction();

            // Lock the reservation row to prevent two concurrent payments from
            // both passing the overpayment check and together exceeding the cost.
            $pdo->prepare('SELECT RES_ID FROM RESERVATION WHERE RES_ID = :r FOR UPDATE')->execute([':r' => $resId]);

            $balance = getReservationBalance($pdo, (int)$resId);
            $wouldBePaid = $balance['total_paid'] + (float)$amt;

            // Business Rule: Overpayment Guard — total payments logged cannot
            // exceed the total reservation cost. Blocked up front, not just
            // flagged after the fact.
            if ($balance['total_cost'] > 0 && $wouldBePaid > $balance['total_cost']) {
                $pdo->rollBack();
                $remaining = max(0, $balance['total_cost'] - $balance['total_paid']);
                $error = sprintf(
                    'Payment rejected: this would overpay the reservation. Remaining balance is ₱%s.',
                    number_format($remaining, 2)
                );
            } else {
                $stmt = $pdo->prepare('INSERT INTO PAYMENT (RES_ID, STAFF_ID, PAY_METHOD, PAY_STATUS, PAY_DATE, PAY_AMT)
                    VALUES (:r, :s, :m, \'Unpaid\', :d, :a) RETURNING PAY_ID');
                $stmt->execute([':r' => $resId, ':s' => currentStaffId(), ':m' => $method, ':d' => $date, ':a' => $amt]);
                $payId = (int)$stmt->fetchColumn();

                // auto-generate receipt (Business Rule: Receipt Generation)
                $stmt = $pdo->prepare('INSERT INTO RECEIPT (PAY_ID, RCT_DATE) VALUES (:p, :d)');
                $stmt->execute([':p' => $payId, ':d' => $date]);

                $pdo->commit();

                $result = syncPaymentStatus($pdo, (int)$resId);
                $success = "Payment #$payId recorded. Reservation status: {$result['status']}.";
            }
        } catch (PDOException $e) {
            if ($pdo->inTransaction()) { $pdo->rollBack(); }
            $error = 'Database error: ' . $e->getMessage();
        }
    }
}

// ---- Refund (Admin/Finance only, traces back to original payment) ----
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['refund_payment'])) {
    requireRole([ROLE_ADMIN, ROLE_FINANCE]);
    $payId = (int)$_POST['pay_id'];

    $stmt = $pdo->prepare("UPDATE PAYMENT SET PAY_STATUS = 'Refunded' WHERE PAY_ID = :id");
    $stmt->execute([':id' => $payId]);

    $stmt = $pdo->prepare('SELECT RES_ID FROM PAYMENT WHERE PAY_ID = :id');
    $stmt->execute([':id' => $payId]);
    $resId = $stmt->fetchColumn();
    if ($resId) {
        syncPaymentStatus($pdo, (int)$resId);
    }
    $success = "Payment #$payId refunded.";
}

$filterResId = $_GET['res_id'] ?? '';

$reservations = $pdo->query("SELECT r.RES_ID, c.CUS_NAME FROM RESERVATION r
    INNER JOIN CUSTOMER c ON c.CUS_ID = r.CUS_ID
    WHERE r.BOOKING_STATUS NOT IN ('Cancelled')
    ORDER BY r.RES_ID DESC")->fetchAll();

$sql = "SELECT p.*, rc.RCT_NO, c.CUS_NAME
    FROM PAYMENT p
    INNER JOIN RESERVATION r ON r.RES_ID = p.RES_ID
    INNER JOIN CUSTOMER c ON c.CUS_ID = r.CUS_ID
    LEFT JOIN RECEIPT rc ON rc.PAY_ID = p.PAY_ID";
$params = [];
if ($filterResId !== '') {
    $sql .= ' WHERE p.RES_ID = :res';
    $params[':res'] = $filterResId;
}
$sql .= ' ORDER BY p.PAY_ID DESC';
$stmt = $pdo->prepare($sql);
$stmt->execute($params);
$payments = $stmt->fetchAll();

$pageTitle = 'Payments';
require __DIR__ . '/../includes/header.php';
?>
<h1>Payments</h1>

<?php if ($error): ?><div class="alert alert-error"><?= h($error) ?></div><?php endif; ?>
<?php if ($success): ?><div class="alert alert-success"><?= h($success) ?></div><?php endif; ?>

<div class="form-box">
  <h3>Record Payment</h3>
  <form method="post" action="/payments">
    <label>Reservation</label>
    <select name="res_id" required>
      <option value="">-- select reservation --</option>
      <?php foreach ($reservations as $r): ?>
        <option value="<?= (int)$r['RES_ID'] ?>" <?= ((string)$r['RES_ID'] === (string)$filterResId) ? 'selected' : '' ?>>
            #<?= (int)$r['RES_ID'] ?> - <?= h($r['CUS_NAME']) ?>
        </option>
      <?php endforeach; ?>
    </select>
    <label>Payment Method</label>
    <select name="pay_method" required>
      <option value="CASH">Cash</option>
      <option value="GCASH">GCash</option>
      <option value="CARD">Card</option>
      <option value="BANK_TRANSFER">Bank Transfer</option>
    </select>
    <label>Amount</label>
    <input type="number" step="0.01" min="0.01" name="pay_amt" required>
    <label>Payment Date</label>
    <input type="date" name="pay_date" value="<?= h(date('Y-m-d')) ?>" required>
    <button type="submit" name="add_payment" class="btn">Record Payment</button>
  </form>
</div>

<h2>Payment History <?= $filterResId !== '' ? '(Reservation #' . h((string)$filterResId) . ')' : '' ?></h2>
<table>
<tr><th>Pay ID</th><th>Guest</th><th>Res. ID</th><th>Method</th><th>Amount</th><th>Date</th><th>Status</th><th>Receipt</th><th>Actions</th></tr>
<?php foreach ($payments as $p): ?>
<tr>
    <td><?= (int)$p['PAY_ID'] ?></td>
    <td><?= h($p['CUS_NAME']) ?></td>
    <td><?= (int)$p['RES_ID'] ?></td>
    <td><?= h($p['PAY_METHOD']) ?></td>
    <td>₱<?= h(number_format((float)$p['PAY_AMT'],2)) ?></td>
    <td><?= h($p['PAY_DATE']) ?></td>
    <td class="status-<?= str_replace(' ','',$p['PAY_STATUS']) ?>"><?= h($p['PAY_STATUS']) ?></td>
    <td><?= $p['RCT_NO'] ? '#' . (int)$p['RCT_NO'] : '-' ?></td>
    <td>
        <?php if ($p['PAY_STATUS'] !== 'Refunded' && in_array(currentRole(), [ROLE_ADMIN, ROLE_FINANCE], true)): ?>
        <form class="inline" method="post" action="/payments" onsubmit="return confirm('Refund this payment?');">
            <input type="hidden" name="pay_id" value="<?= (int)$p['PAY_ID'] ?>">
            <button type="submit" name="refund_payment" class="btn btn-small btn-danger">Refund</button>
        </form>
        <?php endif; ?>
    </td>
</tr>
<?php endforeach; ?>
</table>

<?php require __DIR__ . '/../includes/footer.php'; ?>
