<?php
require_once __DIR__ . '/includes/auth.php';
require_once __DIR__ . '/includes/functions.php';

$error = '';

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $username = trim($_POST['username'] ?? '');
    $password = $_POST['password'] ?? '';

    if ($username === '' || $password === '') {
        $error = 'Please enter both username and password.';
    } elseif (attemptLogin($username, $password)) {
        header('Location: /bookinn/dashboard.php');
        exit;
    } else {
        $error = 'Invalid username or password.';
    }
}

if (isLoggedIn()) {
    header('Location: /bookinn/dashboard.php');
    exit;
}

$pageTitle = 'Login';
require __DIR__ . '/includes/header.php';
?>
<div class="login-wrap">
  <div class="login-box">
    <h1>BookInn</h1>
    <?php if ($error): ?>
      <div class="alert alert-error"><?= h($error) ?></div>
    <?php endif; ?>
    <form method="post" action="/bookinn/login.php">
      <label>Username</label>
      <input type="text" name="username" required autofocus>
      <label>Password</label>
      <input type="password" name="password" required>
      <button type="submit" class="btn" style="width:100%; margin-top:16px;">Log In</button>
    </form>
  </div>
</div>
<?php require __DIR__ . '/includes/footer.php'; ?>
