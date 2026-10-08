<?php
/**
 * One-time setup script: sets real password hashes for the seeded staff
 * accounts (run this once after importing schema.sql).
 * Usage: run this once locally via `php database/seed_passwords.php`
 * (against your Supabase DB, using the credentials in your local .env).
 * This file is excluded from the Vercel deployment via .vercelignore —
 * it must never be reachable over the web, since it contains default
 * plaintext passwords in its source.
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
