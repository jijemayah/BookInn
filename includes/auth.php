<?php
/**
 * BookInn - Authentication & Role-Based Access Control (RBAC)
 * FR-01..FR-06 and Business Rules: User Accounts & System Access
 */

require_once __DIR__ . '/db.php';

if (session_status() === PHP_SESSION_NONE) {
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

    if (!$staff || (int)$staff['IS_ACTIVE'] !== 1) {
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
        header('Location: /bookinn/login.php');
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
        $stmt->execute([':s' => $staffId, ':a' => $action, ':ok' => $authorized ? 1 : 0]);
    } catch (Throwable $e) {
        // Do not block the request if logging fails; the DB may not be migrated yet.
    }
}
