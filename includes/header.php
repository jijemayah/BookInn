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
<link rel="stylesheet" href="/assets/style.css">
</head>
<body>
<?php if (isLoggedIn()): ?>
<header class="topbar">
    <div class="brand">BookInn</div>
    <nav>
        <a href="/dashboard">Dashboard</a>
        <a href="/customers">Guests</a>
        <a href="/rooms">Rooms</a>
        <a href="/reservations">Reservations</a>
        <a href="/payments">Payments</a>
        <?php if (in_array(currentRole(), [ROLE_ADMIN, ROLE_FINANCE], true)): ?>
        <a href="/reports">Reports</a>
        <?php endif; ?>
        <?php if (currentRole() === ROLE_ADMIN): ?>
        <a href="/staff">Staff</a>
        <?php endif; ?>
    </nav>
    <div class="session-info">
        <?= h($_SESSION['name']) ?> (<?= h($_SESSION['role']) ?>)
        &middot; <a href="/logout">Logout</a>
    </div>
</header>
<?php endif; ?>
<main class="container">
