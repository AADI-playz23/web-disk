<?php
// ── Slot Status API (Redis-based, with stale runner detection) ──
require 'db.php';
header('Content-Type: application/json');

if (!isset($_GET['username']) || !isset($_GET['site_id'])) {
    echo json_encode(["status" => "offline"]);
    exit;
}

$username = preg_replace('/[^a-zA-Z0-9-]/', '', $_GET['username']);
$site_id  = intval($_GET['site_id']);
$key      = "{$username}_{$site_id}";

// Read status from Redis
$session_data = redis_cmd(["HGETALL", "session:$key"]);
$session = redis_parse_hash($session_data);

$status = $session['status'] ?? 'offline';

// ── STALE RUNNER DETECTION ──
// If status is "live" or "booting", verify the runner is actually alive
if ($status === 'live' || $status === 'booting') {
    $runner_id = $session['runner_id'] ?? '';
    $is_stale = false;

    if (!empty($runner_id)) {
        // Check runner heartbeat
        $heartbeat = redis_cmd(["HGET", "runner:$runner_id", "heartbeat"]);
        if (!$heartbeat || (time() - intval($heartbeat)) > 120) {
            $is_stale = true;
        }
    } else if ($status === 'booting') {
        // Booting but no runner_id — check if booting for too long (> 5 min)
        $session_start = intval($session['session_start'] ?? 0);
        if ($session_start > 0 && (time() - $session_start) > 300) {
            $is_stale = true;
        } else if ($session_start === 0) {
            // No session_start at all — check if booting status is older than 5 min
            // We can't tell exactly, so mark stale if no runner picks it up
            $is_stale = false; // Give it time
        }
    } else if ($status === 'live' && empty($runner_id)) {
        // Live with no runner_id — definitely stale
        $is_stale = true;
    }

    if ($is_stale) {
        // Auto-clean: mark as offline
        redis_cmd(["HSET", "session:$key", "status", "offline", "url", ""]);
        $status = 'offline';

        // Clean up runner from active set if needed
        if (!empty($runner_id)) {
            redis_cmd(["SREM", "runners:active", $runner_id]);
            redis_cmd(["DEL", "runner:$runner_id"]);
            redis_cmd(["DEL", "runner:$runner_id:slots"]);
        }
    }
}

$response = ['status' => $status];

if ($status === 'live' && !empty($session['url'])) {
    $response['url'] = $session['url'];
}

echo json_encode($response);
$conn->close();
?>
