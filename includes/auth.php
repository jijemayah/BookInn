<?php
/**
 * BookInn - Authentication & Role-Based Access Control (RBAC)
 * FR-01..FR-06 and Business Rules: User Accounts & System Access
 */

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/db_session_handler.php';

if (session_status() === PHP_SESSION_NONE) {
    // Use DB-backed sessions (APP_SESSION table) instead of PHP's default
    // file-based session storage, since Vercel's serverless PHP runtime
    // does not guarantee a shared, persistent filesystem across requests.
    session_set_save_handler(new DbSessionHandler(getDbConnection()), true);
    // Serverless functions typically run behind HTTPS at the platform edge;
    // mark the session cookie accordingly so it isn't sent over plain HTTP.
    session_set_cookie_params([
        'lifetime' => 0,
        'path'     => '/',
        'secure'   => !empty($_SERVER['HTTPS']) || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https'),
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    session_start();
}

/** Roles allowed in the system */
const ROLE_ADMIN      = 'Administrator';
const ROLE_FRONT_DESK = 'Front Desk Staff';
const ROLE_FINANCE    = 'Finance Officer';

/**
 * Attempt to log a staff member in.
 * Returns true on success, false on failure (bad credentials or deactivated account).
 */
function attemptLogin(string $username, string $password): bool {
    $pdo = getDbConnection();
    $stmt = $pdo->prepare('SELECT STAFF_ID, U_NAME, PASS, NAME, ROLE, IS_ACTIVE FROM STAFF WHERE U_NAME = :u');
    $stmt->execute([':u' => $username]);
    $staff = $stmt->fetch();

    if (!$staff || $staff['IS_ACTIVE'] !== true) {
        logAccess(null, 'LOGIN_ATTEMPT', false);
        return false;
    }

    if (!password_verify($password, $staff['PASS'])) {
        logAccess((int)$staff['STAFF_ID'], 'LOGIN_ATTEMPT', false);
        return false;
    }

    $_SESSION['staff_id'] = (int)$staff['STAFF_ID'];
    $_SESSION['u_name']   = $staff['U_NAME'];
    $_SESSION['name']     = $staff['NAME'];
    $_SESSION['role']     = $staff['ROLE'];

    logAccess((int)$staff['STAFF_ID'], 'LOGIN_SUCCESS', true);
    return true;
}

function logoutUser(): void {
    if (isset($_SESSION['staff_id'])) {
        logAccess((int)$_SESSION['staff_id'], 'LOGOUT', true);
    }
    $_SESSION = [];
    session_destroy();
}

function isLoggedIn(): bool {
    return isset($_SESSION['staff_id']);
}

function currentRole(): ?string {
    return $_SESSION['role'] ?? null;
}

function currentStaffId(): ?int {
    return $_SESSION['staff_id'] ?? null;
}

/**
 * Ensure the current user is logged in; redirect to login page otherwise.
 */
function requireLogin(): void {
    if (!isLoggedIn()) {
        header('Location: /login');
        exit;
    }
}

/**
 * Ensure the current user has one of the allowed roles.
 * Logs unauthorized attempts (Business Rule: Role Permissions).
 */
function requireRole(array $allowedRoles): void {
    requireLogin();
    $role = currentRole();
    if (!in_array($role, $allowedRoles, true)) {
        logAccess(currentStaffId(), 'UNAUTHORIZED_ACCESS:' . implode(',', $allowedRoles), false);
        http_response_code(403);
        die('Access denied: your role (' . htmlspecialchars($role ?? '') . ') is not permitted to view this page.');
    }
}

function logAccess(?int $staffId, string $action, bool $authorized): void {
    try {
        $pdo = getDbConnection();
        $stmt = $pdo->prepare('INSERT INTO ACCESS_LOG (STAFF_ID, ACTION, IS_AUTHORIZED) VALUES (:s, :a, :ok)');
        // Bind the boolean explicitly as PDO::PARAM_BOOL. With native prepared
        // statements (PDO::ATTR_EMULATE_PREPARES = false), passing a plain PHP
        // bool through the execute([...]) array shorthand gets sent to Postgres
        // as an empty string and fails with "invalid input syntax for type
        // boolean" — bindValue() with an explicit type avoids that.
        $stmt->bindValue(':s', $staffId, $staffId === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
        $stmt->bindValue(':a', $action, PDO::PARAM_STR);
        $stmt->bindValue(':ok', $authorized, PDO::PARAM_BOOL);
        $stmt->execute();
    } catch (Throwable $e) {
        // Do not block the request if logging fails; the DB may not be migrated yet.
    }
}
