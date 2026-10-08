<?php
/**
 * BookInn - Database Connection
 * Plain PHP configuration (no JSON/YAML config files).
 * Uses PDO with MySQL via XAMPP.
 */

// ---- Connection settings (edit these if your XAMPP MySQL differs) ----
define('DB_HOST', '127.0.0.1');
define('DB_PORT', '3306');
define('DB_NAME', 'bookinn');
define('DB_USER', 'root');
define('DB_PASS', '');       // default XAMPP root password is empty
define('DB_CHARSET', 'utf8mb4');

/**
 * Returns a shared PDO connection instance.
 */
function getDbConnection(): PDO {
    static $pdo = null;

    if ($pdo === null) {
        $dsn = 'mysql:host=' . DB_HOST . ';port=' . DB_PORT . ';dbname=' . DB_NAME . ';charset=' . DB_CHARSET;
        try {
            $pdo = new PDO($dsn, DB_USER, DB_PASS, [
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES   => false,
            ]);
        } catch (PDOException $e) {
            http_response_code(500);
            die('Database connection failed: ' . htmlspecialchars($e->getMessage()));
        }
    }

    return $pdo;
}
