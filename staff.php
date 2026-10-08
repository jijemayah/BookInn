<?php
require_once __DIR__ . '/includes/auth.php';
require_once __DIR__ . '/includes/functions.php';
requireRole([ROLE_ADMIN]); // FR-04, FR-05: only admins manage roles/accounts

$pdo = getDbConnection();
$error = '';
$success = '';

if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['add_staff'])) {
    $uname = trim($_POST['u_name'] ?? '');
    $name  = trim($_POST['name'] ?? '');
    $role  = $_POST['role'] ?? '';
    $pass  = $_POST['password'] ?? '';

    $validRoles = [ROLE_ADMIN, ROLE_FRONT_DESK, ROLE_FINANCE];
    // Password Security business rule: upper+lower+number+special, min 8 chars
    $strong = preg_match('/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z\d]).{8,}$/', $pass);

    if ($uname === '' || $name === '' || !in_array($role, $validRoles, true)) {
        $error = 'All fields are required and role must be valid.';
    } elseif (!$strong) {
        $error = 'Password must be at least 8 characters and include uppercase, lowercase, a number, and a special character.';
    } else {
        try {
            $stmt = $pdo->prepare('INSERT INTO STAFF (U_NAME, PASS, NAME, ROLE) VALUES (:u, :p, :n, :r)');
            $stmt->execute([':u' => $uname, ':p' => password_hash($pass, PASSWORD_DEFAULT), ':n' => $name, ':r' => $role]);
            $success = 'Staff account created.';
        } catch (PDOException $e) {
            $error = ($e->getCode() == 23505) ? 'That username already exists.' : 'Database error: ' . $e->getMessage();
        }
    }
}

if (isset($_GET['deactivate'])) {
    $id = (int)$_GET['deactivate'];
    if ($id === currentStaffId()) {
        $error = 'You cannot deactivate your own account while logged in.';
    } else {
        $stmt = $pdo->prepare('UPDATE STAFF SET IS_ACTIVE = FALSE WHERE STAFF_ID = :id');
        $stmt->execute([':id' => $id]);
        $success = 'Account deactivated.';
    }
}

if (isset($_GET['activate'])) {
    $stmt = $pdo->prepare('UPDATE STAFF SET IS_ACTIVE = TRUE WHERE STAFF_ID = :id');
    $stmt->execute([':id' => (int)$_GET['activate']]);
    $success = 'Account reactivated.';
}

$staffList = $pdo->query('SELECT * FROM STAFF ORDER BY STAFF_ID')->fetchAll();

$pageTitle = 'Staff';
require __DIR__ . '/includes/header.php';
?>
<h1>Staff Accounts</h1>

<?php if ($error): ?><div class="alert alert-error"><?= h($error) ?></div><?php endif; ?>
<?php if ($success): ?><div class="alert alert-success"><?= h($success) ?></div><?php endif; ?>

<div class="form-box">
  <h3>Add Staff Account</h3>
  <form method="post" action="/bookinn/staff.php">
    <label>Username</label>
    <input type="text" name="u_name" required>
    <label>Full Name</label>
    <input type="text" name="name" required>
    <label>Role</label>
    <select name="role" required>
      <option value="Administrator">Administrator</option>
      <option value="Front Desk Staff">Front Desk Staff</option>
      <option value="Finance Officer">Finance Officer</option>
    </select>
    <label>Password</label>
    <input type="password" name="password" required>
    <small>Min 8 chars, with uppercase, lowercase, number, and special character.</small>
    <button type="submit" name="add_staff" class="btn">Create Account</button>
  </form>
</div>

<h2>All Staff</h2>
<table>
<tr><th>ID</th><th>Username</th><th>Name</th><th>Role</th><th>Status</th><th>Actions</th></tr>
<?php foreach ($staffList as $s): ?>
<tr>
    <td><?= (int)$s['STAFF_ID'] ?></td>
    <td><?= h($s['U_NAME']) ?></td>
    <td><?= h($s['NAME']) ?></td>
    <td><?= h($s['ROLE']) ?></td>
    <td><?= $s['IS_ACTIVE'] ? '<span class="status-Available">Active</span>' : '<span class="status-Unavailable">Deactivated</span>' ?></td>
    <td>
        <?php if ($s['IS_ACTIVE']): ?>
        <a class="btn btn-small btn-danger" href="/bookinn/staff.php?deactivate=<?= (int)$s['STAFF_ID'] ?>"
           onclick="return confirm('Deactivate this account?');">Deactivate</a>
        <?php else: ?>
        <a class="btn btn-small" href="/bookinn/staff.php?activate=<?= (int)$s['STAFF_ID'] ?>">Reactivate</a>
        <?php endif; ?>
    </td>
</tr>
<?php endforeach; ?>
</table>

<?php require __DIR__ . '/includes/footer.php'; ?>
