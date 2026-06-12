<?php
// ── Quota & Usage API ──
// GET  ?username=X&site_id=Y  → returns session + weekly usage info
require 'db.php';
header('Content-Type: application/json');

if (!isset($_GET['username']) || !isset($_GET['site_id'])) {
    echo json_encode(["error" => "Missing params"]);
    exit;
}

$username = preg_replace('/[^a-zA-Z0-9-]/', '', $_GET['username']);
$site_id  = intval($_GET['site_id']);
$key      = "{$username}_{$site_id}";

// 1. Fetch user plan from MySQL
$plan = 'starter';
$stmt = $conn->prepare("SELECT plan FROM users WHERE username = ?");
if ($stmt) {
    $stmt->bind_param("s", $username);
    $stmt->execute();
    $result = $stmt->get_result();
    $plan = ($row = $result->fetch_assoc()) ? $row['plan'] : "starter";
    $stmt->close();
}

// 2. Get plan limits
$limits = getPlanLimits($plan);

// 3. Get weekly usage (auto-resets if 7 days elapsed)
$usage = getWeeklyUsage($username, $site_id);

// 4. Get current session info from Redis
$session_data = redis_cmd(["HGETALL", "session:$key"]);
$session = redis_parse_hash($session_data);

$status        = $session['status'] ?? 'offline';
$session_start = intval($session['session_start'] ?? 0);

// Calculate session elapsed & remaining (only if live)
$session_elapsed   = 0;
$session_remaining = $limits['session'];

if ($session_start > 0 && $status === 'live') {
    $session_elapsed   = time() - $session_start;
    $session_remaining = max(0, $limits['session'] - $session_elapsed);
}

// Weekly remaining
$weekly_remaining = max(0, $limits['weekly'] - $usage['weekly_seconds']);
$week_resets_at   = $usage['week_start'] + 604800;

echo json_encode([
    "plan"              => $plan,
    "status"            => $status,
    "session_elapsed"   => $session_elapsed,
    "session_remaining" => $session_remaining,
    "session_limit"     => $limits['session'],
    "weekly_used"       => $usage['weekly_seconds'],
    "weekly_remaining"  => $weekly_remaining,
    "weekly_limit"      => $limits['weekly'],
    "weekly_resets_at"  => $week_resets_at
]);

$conn->close();
?>
