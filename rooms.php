<?php
require_once __DIR__ . '/includes/auth.php';
require_once __DIR__ . '/includes/functions.php';
requireRole([ROLE_ADMIN, ROLE_FRONT_DESK]);

$pdo = getDbConnection();
$error = '';
$success = '';

// ---- Add Room Type ----
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['add_room_type'])) {
    $typeName = trim($_POST['room_type'] ?? '');
    $price    = $_POST['room_price'] ?? '';
    if ($typeName === '' || $price === '' || !is_numeric($price) || (float)$price < 0) {
        $error = 'Valid room type name and price are required.';
    } else {
        try {
            $stmt = $pdo->prepare('INSERT INTO ROOM_TYPE (ROOM_TYPE, ROOM_PRICE) VALUES (:t, :p)');
            $stmt->execute([':t' => $typeName, ':p' => $price]);
            $success = 'Room type added.';
        } catch (PDOException $e) {
            $error = ($e->getCode() == 23505) ? 'That room type already exists.' : 'Database error: ' . $e->getMessage();
        }
    }
}

// ---- Add Room ----
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['add_room'])) {
    $roomNo = $_POST['room_no'] ?? '';
    $typeId = $_POST['room_type_id'] ?? '';
    if ($roomNo === '' || !ctype_digit($roomNo) || $typeId === '') {
        $error = 'Valid room number and room type are required.';
    } else {
        try {
            $stmt = $pdo->prepare('INSERT INTO ROOM (ROOM_NO, ROOM_TYPE_ID, ROOM_STATUS) VALUES (:n, :t, \'Available\')');
            $stmt->execute([':n' => $roomNo, ':t' => $typeId]);
            $success = 'Room added.';
        } catch (PDOException $e) {
            $error = ($e->getCode() == 23505) ? 'That room number already exists.' : 'Database error: ' . $e->getMessage();
        }
    }
}

// ---- Toggle maintenance lock (Unavailable <-> Available) ----
if (isset($_GET['toggle_lock'])) {
    $roomNo = (int)$_GET['toggle_lock'];
    $stmt = $pdo->prepare('SELECT ROOM_STATUS FROM ROOM WHERE ROOM_NO = :n');
    $stmt->execute([':n' => $roomNo]);
    $current = $stmt->fetchColumn();

    if ($current === 'Unavailable') {
        syncRoomStatus($pdo, $roomNo, true); // manually clear the lock, recompute real status
    } elseif ($current === 'Available') {
        $stmt = $pdo->prepare("UPDATE ROOM SET ROOM_STATUS = 'Unavailable' WHERE ROOM_NO = :n");
        $stmt->execute([':n' => $roomNo]);
    } else {
        $error = 'Cannot lock a room that is currently Reserved or Occupied.';
    }
    header('Location: /bookinn/rooms.php');
    exit;
}

$roomTypes = $pdo->query('SELECT * FROM ROOM_TYPE ORDER BY ROOM_TYPE')->fetchAll();
$rooms = $pdo->query('SELECT ro.*, rt.ROOM_TYPE, rt.ROOM_PRICE
    FROM ROOM ro INNER JOIN ROOM_TYPE rt ON rt.ROOM_TYPE_ID = ro.ROOM_TYPE_ID
    ORDER BY ro.ROOM_NO')->fetchAll();

$pageTitle = 'Rooms';
require __DIR__ . '/includes/header.php';
?>
<h1>Room Management</h1>

<?php if ($error): ?><div class="alert alert-error"><?= h($error) ?></div><?php endif; ?>
<?php if ($success): ?><div class="alert alert-success"><?= h($success) ?></div><?php endif; ?>

<div class="form-box">
  <h3>Add Room Type</h3>
  <form method="post" action="/bookinn/rooms.php">
    <label>Room Type Name</label>
    <input type="text" name="room_type" required placeholder="e.g. Standard, Deluxe">
    <label>Price per Day</label>
    <input type="number" step="0.01" min="0" name="room_price" required>
    <button type="submit" name="add_room_type" class="btn">Add Room Type</button>
  </form>
</div>

<div class="form-box">
  <h3>Add Room</h3>
  <form method="post" action="/bookinn/rooms.php">
    <label>Room Number</label>
    <input type="text" name="room_no" required pattern="[0-9]+">
    <label>Room Type</label>
    <select name="room_type_id" required>
      <option value="">-- select --</option>
      <?php foreach ($roomTypes as $rt): ?>
        <option value="<?= (int)$rt['ROOM_TYPE_ID'] ?>"><?= h($rt['ROOM_TYPE']) ?> (₱<?= h(number_format((float)$rt['ROOM_PRICE'],2)) ?>/day)</option>
      <?php endforeach; ?>
    </select>
    <button type="submit" name="add_room" class="btn">Add Room</button>
  </form>
</div>

<h2>Room Types</h2>
<table>
<tr><th>ID</th><th>Type</th><th>Price/Day</th></tr>
<?php foreach ($roomTypes as $rt): ?>
<tr><td><?= (int)$rt['ROOM_TYPE_ID'] ?></td><td><?= h($rt['ROOM_TYPE']) ?></td><td>₱<?= h(number_format((float)$rt['ROOM_PRICE'],2)) ?></td></tr>
<?php endforeach; ?>
</table>

<h2>Rooms</h2>
<table>
<tr><th>Room No.</th><th>Type</th><th>Price/Day</th><th>Status</th><th>Actions</th></tr>
<?php foreach ($rooms as $r): ?>
<tr>
    <td><?= (int)$r['ROOM_NO'] ?></td>
    <td><?= h($r['ROOM_TYPE']) ?></td>
    <td>₱<?= h(number_format((float)$r['ROOM_PRICE'],2)) ?></td>
    <td class="status-<?= h($r['ROOM_STATUS']) ?>"><?= h($r['ROOM_STATUS']) ?></td>
    <td>
        <?php if (in_array($r['ROOM_STATUS'], ['Available','Unavailable'], true)): ?>
        <a class="btn btn-small <?= $r['ROOM_STATUS']==='Unavailable' ? '' : 'btn-danger' ?>"
           href="/bookinn/rooms.php?toggle_lock=<?= (int)$r['ROOM_NO'] ?>">
           <?= $r['ROOM_STATUS']==='Unavailable' ? 'Clear Lock' : 'Mark Unavailable' ?>
        </a>
        <?php else: ?>
        <span style="color:#999;">Locked while <?= h($r['ROOM_STATUS']) ?></span>
        <?php endif; ?>
    </td>
</tr>
<?php endforeach; ?>
</table>

<?php require __DIR__ . '/includes/footer.php'; ?>
