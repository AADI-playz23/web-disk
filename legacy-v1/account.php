<?php
// ── Account Info API (enhanced with usage data) ──
require 'db.php';
header('Content-Type: application/json');

if (!isset($_GET['username'])) {
    echo json_encode(["plan" => "starter", "slots" => 1]);
    exit;
}

$username = preg_replace('/[^a-zA-Z0-9-]/', '', $_GET['username']);

// Fetch plan from MySQL
$stmt = $conn->prepare("SELECT plan FROM users WHERE username = ?");
$stmt->bind_param("s", $username);
$stmt->execute();
$result = $stmt->get_result();

if ($result->num_rows > 0) {
    $row  = $result->fetch_assoc();
    $plan = $row['plan'];
} else {
    $plan = 'starter';
}
$stmt->close();

$slots  = getSlotsForPlan($plan);
$limits = getPlanLimits($plan);

// Aggregate weekly usage across all slots
$total_weekly_used = 0;
for ($i = 1; $i <= $slots; $i++) {
    $usage = getWeeklyUsage($username, $i);
    $total_weekly_used += $usage['weekly_seconds'];
}

echo json_encode([
    "plan"             => $plan,
    "slots"            => $slots,
    "session_limit"    => $limits['session'],
    "weekly_limit"     => $limits['weekly'],
    "weekly_used"      => $total_weekly_used,
    "weekly_remaining" => max(0, $limits['weekly'] - $total_weekly_used)
]);

$conn->close();
?>
