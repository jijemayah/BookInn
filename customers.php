<?php
require_once __DIR__ . '/includes/auth.php';
require_once __DIR__ . '/includes/functions.php';
requireRole([ROLE_ADMIN, ROLE_FRONT_DESK]);

$pdo = getDbConnection();
$error = '';
$success = '';

// ---- Create / Update ----
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $name   = trim($_POST['cus_name'] ?? '');
    $email  = trim($_POST['cus_email'] ?? '');
    $mobile = trim($_POST['cus_mobile'] ?? '');
    $validId = trim($_POST['valid_id'] ?? '');
    $cusId  = $_POST['cus_id'] ?? '';

    if ($name === '' || $email === '' || $mobile === '') {
        $error = 'Name, email, and mobile number are required.';
    } else {
        try {
            if ($cusId !== '') {
                $stmt = $pdo->prepare('UPDATE CUSTOMER SET CUS_NAME=:n, CUS_EMAIL=:e, CUS_MOBILE=:m, VALID_ID=:v WHERE CUS_ID=:id');
                $stmt->execute([':n'=>$name, ':e'=>$email, ':m'=>$mobile, ':v'=>$validId, ':id'=>$cusId]);
                $success = 'Guest updated.';
            } else {
                $stmt = $pdo->prepare('INSERT INTO CUSTOMER (CUS_NAME, CUS_EMAIL, CUS_MOBILE, VALID_ID) VALUES (:n,:e,:m,:v)');
                $stmt->execute([':n'=>$name, ':e'=>$email, ':m'=>$mobile, ':v'=>$validId]);
                $success = 'Guest added.';
            }
        } catch (PDOException $e) {
            $error = ($e->getCode() == 23000) ? 'A guest with that email already exists.' : 'Database error: ' . $e->getMessage();
        }
    }
}

// ---- Archive (soft-delete, guest history retained per Business Rules) ----
if (isset($_GET['archive'])) {
    $stmt = $pdo->prepare('UPDATE CUSTOMER SET IS_ACTIVE = 0 WHERE CUS_ID = :id');
    $stmt->execute([':id' => (int)$_GET['archive']]);
    header('Location: /bookinn/customers.php');
    exit;
}

$editCustomer = null;
if (isset($_GET['edit'])) {
    $stmt = $pdo->prepare('SELECT * FROM CUSTOMER WHERE CUS_ID = :id');
    $stmt->execute([':id' => (int)$_GET['edit']]);
    $editCustomer = $stmt->fetch();
}

$customers = $pdo->query('SELECT * FROM CUSTOMER WHERE IS_ACTIVE = 1 ORDER BY CUS_NAME')->fetchAll();

$pageTitle = 'Guests';
require __DIR__ . '/includes/header.php';
?>
<h1>Guest Management</h1>

<?php if ($error): ?><div class="alert alert-error"><?= h($error) ?></div><?php endif; ?>
<?php if ($success): ?><div class="alert alert-success"><?= h($success) ?></div><?php endif; ?>

<div class="form-box">
  <h3><?= $editCustomer ? 'Edit Guest' : 'Add Guest' ?></h3>
  <form method="post" action="/bookinn/customers.php">
    <?php if ($editCustomer): ?><input type="hidden" name="cus_id" value="<?= h((string)$editCustomer['CUS_ID']) ?>"><?php endif; ?>
    <label>Full Name</label>
    <input type="text" name="cus_name" required value="<?= h($editCustomer['CUS_NAME'] ?? '') ?>">
    <label>Email</label>
    <input type="email" name="cus_email" required value="<?= h($editCustomer['CUS_EMAIL'] ?? '') ?>">
    <label>Mobile Number</label>
    <input type="text" name="cus_mobile" required value="<?= h($editCustomer['CUS_MOBILE'] ?? '') ?>">
    <label>Valid ID (reference no.)</label>
    <input type="text" name="valid_id" value="<?= h($editCustomer['VALID_ID'] ?? '') ?>">
    <button type="submit" class="btn"><?= $editCustomer ? 'Update Guest' : 'Add Guest' ?></button>
  </form>
</div>

<h2>Guest List</h2>
<table>
<tr><th>ID</th><th>Name</th><th>Email</th><th>Mobile</th><th>Valid ID</th><th>Actions</th></tr>
<?php foreach ($customers as $c): ?>
<tr>
    <td><?= h((string)$c['CUS_ID']) ?></td>
    <td><?= h($c['CUS_NAME']) ?></td>
    <td><?= h($c['CUS_EMAIL']) ?></td>
    <td><?= h($c['CUS_MOBILE']) ?></td>
    <td><?= h($c['VALID_ID']) ?></td>
    <td>
        <a class="btn btn-small" href="/bookinn/customers.php?edit=<?= (int)$c['CUS_ID'] ?>">Edit</a>
        <a class="btn btn-small btn-danger" href="/bookinn/customers.php?archive=<?= (int)$c['CUS_ID'] ?>"
           onclick="return confirm('Archive this guest? Historical bookings are retained.');">Archive</a>
    </td>
</tr>
<?php endforeach; ?>
</table>

<?php require __DIR__ . '/includes/footer.php'; ?>
