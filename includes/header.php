<?php
require_once __DIR__ . '/functions.php';

/**
 * Shared HTML header. Expects $pageTitle to be set by the including page.
 */
$pageTitle = $pageTitle ?? 'BookInn';
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title><?= h($pageTitle) ?> - BookInn</title>
<link rel="stylesheet" href="/bookinn/assets/style.css">
</head>
<body>
<?php if (isLoggedIn()): ?>
<header class="topbar">
    <div class="brand">BookInn</div>
    <nav>
        <a href="/bookinn/dashboard.php">Dashboard</a>
        <a href="/bookinn/customers.php">Guests</a>
        <a href="/bookinn/rooms.php">Rooms</a>
        <a href="/bookinn/reservations.php">Reservations</a>
        <a href="/bookinn/payments.php">Payments</a>
        <?php if (in_array(currentRole(), [ROLE_ADMIN, ROLE_FINANCE], true)): ?>
        <a href="/bookinn/reports.php">Reports</a>
        <?php endif; ?>
        <?php if (currentRole() === ROLE_ADMIN): ?>
        <a href="/bookinn/staff.php">Staff</a>
        <?php endif; ?>
    </nav>
    <div class="session-info">
        <?= h($_SESSION['name']) ?> (<?= h($_SESSION['role']) ?>)
        &middot; <a href="/bookinn/logout.php">Logout</a>
    </div>
</header>
<?php endif; ?>
<main class="container">
