<?php
/**
 * BookInn - Database Connection
 * Plain PHP configuration (no JSON/YAML config files).
 * Uses PDO with PostgreSQL via Supabase.
 *
 * Connection details are read from environment variables so real
 * credentials never need to be committed to source control. Populate
 * them via a .env file (see .env.example) loaded by your web server /
 * runtime, or real OS environment variables.
 *
 * Required env vars (get these from your Supabase project ->
 * Project Settings -> Database -> Connection parameters):
 *   SUPABASE_DB_HOST     e.g. db.xxxxxxxxxxxx.supabase.co
 *   SUPABASE_DB_PORT     usually 5432 (direct) or 6543 (pooled/pgbouncer)
 *   SUPABASE_DB_NAME     usually "postgres"
 *   SUPABASE_DB_USER     usually "postgres" (or a scoped role you create)
 *   SUPABASE_DB_PASSWORD the database password set for your project
 *   SUPABASE_DB_SSLMODE  optional, defaults to "require"
 */

/**
 * Minimal .env loader (no external dependencies). Only used if a .env
 * file exists at the project root; real environment variables always
 * take precedence and are never overwritten.
 */
function loadEnvFile(string $path): void {
    if (!is_file($path) || !is_readable($path)) {
        return;
    }
    $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '' || str_starts_with($line, '#')) {
            continue;
        }
        if (!str_contains($line, '=')) {
            continue;
        }
        [$name, $value] = explode('=', $line, 2);
        $name  = trim($name);
        $value = trim($value);
        // Strip matching surrounding quotes, if present
        if (strlen($value) >= 2) {
            $first = $value[0];
            $last  = $value[strlen($value) - 1];
            if (($first === '"' && $last === '"') || ($first === "'" && $last === "'")) {
                $value = substr($value, 1, -1);
            }
        }
        if (getenv($name) === false) {
            putenv("$name=$value");
            $_ENV[$name] = $value;
        }
    }
}

loadEnvFile(__DIR__ . '/../.env');

/**
 * Reads an environment variable with an optional default.
 */
function envOrDefault(string $name, ?string $default = null): ?string {
    $value = getenv($name);
    return ($value === false || $value === '') ? $default : $value;
}

// ---- Connection settings (populate via .env or real env vars) ----
define('DB_HOST',     envOrDefault('SUPABASE_DB_HOST', '127.0.0.1'));
define('DB_PORT',     envOrDefault('SUPABASE_DB_PORT', '5432'));
define('DB_NAME',     envOrDefault('SUPABASE_DB_NAME', 'postgres'));
define('DB_USER',     envOrDefault('SUPABASE_DB_USER', 'postgres'));
define('DB_PASS',     envOrDefault('SUPABASE_DB_PASSWORD', ''));
define('DB_SSLMODE',  envOrDefault('SUPABASE_DB_SSLMODE', 'require'));

/**
 * Returns a shared PDO connection instance.
 */
function getDbConnection(): PDO {
    static $pdo = null;

    if ($pdo === null) {
        $dsn = 'pgsql:host=' . DB_HOST . ';port=' . DB_PORT . ';dbname=' . DB_NAME . ';sslmode=' . DB_SSLMODE;
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
