<?php
// ── Dashboard API: Launch / Delete slots via Redis queue ──
require 'db.php';

if (isset($_POST['username']) && isset($_POST['site_id'])) {
    $username = preg_replace('/[^a-zA-Z0-9-]/', '', trim($_POST['username']));
    $site_id  = intval($_POST['site_id']);
    $action   = isset($_POST['action']) ? $_POST['action'] : 'launch';
    $key      = "{$username}_{$site_id}";

    // ═══════════════════════════════════════════
    //  LAUNCH
    // ═══════════════════════════════════════════
    if ($action === 'launch') {
        if (!isset($_POST['password'])) die("Error: Password required.");

        // 1. Fetch Plan from MySQL
        $stmt = $conn->prepare("SELECT plan FROM users WHERE username = ?");
        $stmt->bind_param("s", $username);
        $stmt->execute();
        $result = $stmt->get_result();
        $plan = ($row = $result->fetch_assoc()) ? $row['plan'] : "starter";
        $stmt->close();

        // 2. Check weekly quota
        $limits = getPlanLimits($plan);
        $usage  = getWeeklyUsage($username, $site_id);

        if ($usage['weekly_seconds'] >= $limits['weekly']) {
            die("Error: Weekly quota exhausted. Upgrade your plan for more hosting time.");
        }

        // 3. Check remaining weekly time is enough for at least 5 min session
        $weekly_remaining = $limits['weekly'] - $usage['weekly_seconds'];
        if ($weekly_remaining < 300) {
            die("Error: Less than 5 minutes of weekly quota remaining. Resets in " .
                ceil(($usage['week_start'] + 604800 - time()) / 3600) . "h.");
        }

        // 4. Check if slot is already live/booting (with stale detection)
        $session_data = redis_cmd(["HGETALL", "session:$key"]);
        $session = redis_parse_hash($session_data);
        $current_status = $session['status'] ?? 'offline';

        // Detect stale sessions (runner died without cleanup)
        if ($current_status === 'live' || $current_status === 'booting') {
            $runner_id = $session['runner_id'] ?? '';
            $is_stale = false;

            if (!empty($runner_id)) {
                $heartbeat = redis_cmd(["HGET", "runner:$runner_id", "heartbeat"]);
                if (!$heartbeat || (time() - intval($heartbeat)) > 120) {
                    $is_stale = true;
                    // Clean up dead runner
                    redis_cmd(["SREM", "runners:active", $runner_id]);
                    redis_cmd(["DEL", "runner:$runner_id"]);
                    redis_cmd(["DEL", "runner:$runner_id:slots"]);
                }
            } else if ($current_status === 'booting') {
                // Booting with no runner_id for > 3 min = stale
                $boot_time = intval($session['session_start'] ?? 0);
                if ($boot_time > 0 && (time() - $boot_time) > 180) {
                    $is_stale = true;
                } else if ($boot_time === 0) {
                    $is_stale = true; // No timestamp = stuck
                }
            }

            if ($is_stale) {
                // Reset session — allow re-launch
                redis_cmd(["HSET", "session:$key", "status", "offline", "url", ""]);
                $current_status = 'offline';
            }
        }

        if ($current_status === 'live') {
            die("Error: This slot is already running.");
        }
        if ($current_status === 'booting') {
            die("Error: This slot is currently booting. Please wait.");
        }

        // 5. Check runner capacity & decide if new runner needed
        $runners = redis_cmd(["SMEMBERS", "runners:active"]);
        $available_runner   = false;
        $active_runner_count = 0;

        if (is_array($runners) && !empty($runners)) {
            foreach ($runners as $rid) {
                $hb = redis_cmd(["HGET", "runner:$rid", "heartbeat"]);
                if ($hb && (time() - intval($hb)) < 120) {
                    $active_runner_count++;
                    $count = redis_cmd(["HGET", "runner:$rid", "active_count"]);
                    if (intval($count) < 10) {
                        $available_runner = true;
                    }
                } else {
                    // Dead runner — clean up stale Redis keys
                    redis_cmd(["SREM", "runners:active", $rid]);
                    redis_cmd(["DEL", "runner:$rid"]);
                    redis_cmd(["DEL", "runner:$rid:slots"]);
                }
            }
        }

        $need_new_runner = !$available_runner;

        // Enforce max 2 runners
        if ($need_new_runner && $active_runner_count >= 2) {
            if ($plan === 'starter') {
                // Free users: only start new runner if queue > 20
                $queue_len = intval(redis_cmd(["LLEN", "queue:deploy"]) ?? 0);
                if ($queue_len < 20) {
                    die("Error: All servers are currently full. Please try again in a few minutes.");
                }
            }
            // Even paid users are blocked if already at 2 runners
            if ($active_runner_count >= 2) {
                die("Error: Maximum server capacity reached. Please try again shortly.");
            }
        }

        // 6. Enforce per-plan new-runner rules
        if ($need_new_runner && $active_runner_count >= 1) {
            // All runners full — check plan eligibility for spawning a second runner
            if ($plan === 'starter') {
                $queue_len = intval(redis_cmd(["LLEN", "queue:deploy"]) ?? 0);
                if ($queue_len < 20) {
                    // Queue not long enough, free users wait
                    // Still push to queue — they'll be served when a slot frees
                    // But don't spawn a new runner
                    $need_new_runner = false;
                }
            }
            // paid users (dev/pro/studio): spawn new runner immediately
        }

        // 7. Calculate effective session limit (capped by remaining weekly quota)
        $effective_session = min($limits['session'], $weekly_remaining);

        // 8. Push deploy request to Redis queue
        $deploy_data = json_encode([
            "username"      => $username,
            "password"      => $_POST['password'],
            "site_id"       => (string)$site_id,
            "plan"          => $plan,
            "session_limit" => $effective_session
        ]);

        redis_cmd(["LPUSH", "queue:deploy", $deploy_data]);

        // 9. Mark slot as booting in Redis
        redis_cmd(["HSET", "session:$key", "status", "booting"]);

        // 10. Upsert slot status in MySQL (legacy compatibility)
        $stmt = $conn->prepare("INSERT INTO slots (username, site_id, status)
                                VALUES (?, ?, 'booting')
                                ON DUPLICATE KEY UPDATE status = 'booting', url = NULL");
        $stmt->bind_param("si", $username, $site_id);
        $stmt->execute();
        $stmt->close();

        // 11. Dispatch a new GitHub runner if needed
        if ($need_new_runner) {
            $url = "https://api.github.com/repos/$owner/$repo_engine/actions/workflows/server.yml/dispatches";
            $payload = [
                "ref"    => "main",
                "inputs" => [
                    "trigger_user" => $username
                ]
            ];

            $ch = curl_init($url);
            curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
            curl_setopt($ch, CURLOPT_POST, true);
            curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload));
            curl_setopt($ch, CURLOPT_HTTPHEADER, [
                "Authorization: token $github_token",
                "Accept: application/vnd.github.v3+json",
                "Content-Type: application/json",
                "User-Agent: AbsoraCloud-API"
            ]);
            curl_exec($ch);
            curl_close($ch);
        }

        echo "Server Started";

    // ═══════════════════════════════════════════
    //  DELETE (Stop Tunnel)
    // ═══════════════════════════════════════════
    } else if ($action === 'delete') {
        // Set kill signal in Redis (runner picks this up and cleans processes)
        redis_cmd(["SET", "kill:$key", "1", "EX", "300"]);

        // Immediately mark as offline in Redis (instant UI feedback)
        redis_cmd(["HSET", "session:$key", "status", "offline", "url", ""]);

        // Update MySQL too
        $stmt = $conn->prepare("UPDATE slots SET status = 'offline', url = NULL
                                WHERE username = ? AND site_id = ?");
        $stmt->bind_param("si", $username, $site_id);
        $stmt->execute();
        $stmt->close();

        echo "Deleted";
    }
}

$conn->close();
?>
