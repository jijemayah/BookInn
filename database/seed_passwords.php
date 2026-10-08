<?php
/**
 * One-time setup script: sets real password hashes for the seeded staff
 * accounts (run this once after importing schema.sql).
 * Usage: visit /bookinn/database/seed_passwords.php in the browser once,
 * then delete or block access to this file.
 *
 * Default passwords (change immediately after first login):
 *   KDPALVARADO -> Front#Desk2026
 *   JESMEDEL    -> Finance#2026
 *   ADMIN       -> Admin#2026
 */

require_once __DIR__ . '/../includes/db.php';

$pdo = getDbConnection();

$accounts = [
    'KDPALVARADO' => 'Front#Desk2026',
    'JESMEDEL'    => 'Finance#2026',
    'ADMIN'       => 'Admin#2026',
];
    
$stmt = $pdo->prepare('UPDATE STAFF SET PASS = :pass WHERE U_NAME = :u');
foreach ($accounts as $uname => $plain) {
    $hash = password_hash($plain, PASSWORD_DEFAULT);
    $stmt->execute([':pass' => $hash, ':u' => $uname]);
}

echo "Password hashes updated for: " . implode(', ', array_keys($accounts)) . "\n";
echo "Default passwords (change after first login):\n";
foreach ($accounts as $uname => $plain) {
    echo " - $uname : $plain\n";
}
