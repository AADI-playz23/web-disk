<?php
// ── InfinityFree MySQL Connection (LEGACY v1 — migrated to Cloudflare D1) ──
$db_host = "sql111.infinityfree.com";
$db_user = "[REDACTED]";
$db_pass = "[REDACTED]";
$db_name = "[REDACTED]";

$conn = new mysqli($db_host, $db_user, $db_pass, $db_name);
if ($conn->connect_error) {
    die(json_encode(["error" => "Database connection failed"]));
}
$conn->set_charset("utf8mb4");

// ── GitHub Config (single source of truth) ──
$github_token = "[REDACTED]";
$owner = "AADI-playz23";
$repo_engine = "web-disk";
$repo_storage = "webstore";

// ── Upstash Redis Config ──
$redis_url   = "https://vocal-filly-130607.upstash.io";
$redis_token = "[REDACTED]";


// ──────────────────────────────────────────────
//  REDIS HELPERS
// ──────────────────────────────────────────────

/**
 * Execute a single Redis command via Upstash REST API.
 * Uses file_get_contents (works on InfinityFree where curl may be blocked).
 * @param array $args  e.g. ["HSET", "key", "field", "value"]
 * @return mixed       The 'result' field from the response, or null on failure.
 */
function redis_cmd($args) {
    global $redis_url, $redis_token;
    
    $payload = json_encode($args);
    
    $opts = [
        'http' => [
            'method'  => 'POST',
            'header'  => "Authorization: Bearer $redis_token\r\nContent-Type: application/json\r\n",
            'content' => $payload,
            'timeout' => 5,
            'ignore_errors' => true
        ],
        'ssl' => [
            'verify_peer' => false,
            'verify_peer_name' => false
        ]
    ];
    
    $context = stream_context_create($opts);
    $res = @file_get_contents($redis_url, false, $context);
    
    if ($res === false) {
        // Fallback: try curl if file_get_contents fails
        if (function_exists('curl_init')) {
            $ch = curl_init($redis_url);
            curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
            curl_setopt($ch, CURLOPT_POST, true);
            curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
            curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
            curl_setopt($ch, CURLOPT_TIMEOUT, 5);
            curl_setopt($ch, CURLOPT_HTTPHEADER, [
                "Authorization: Bearer $redis_token",
                "Content-Type: application/json"
            ]);
            $res = curl_exec($ch);
            curl_close($ch);
        }
        if (!$res) return null;
    }
    
    $data = json_decode($res, true);
    return $data['result'] ?? null;
}

/**
 * Execute multiple Redis commands in a single pipeline call.
 * @param array $commands  Array of command arrays, e.g. [["SET","k","v"], ["EXPIRE","k","60"]]
 * @return array           Array of results from each command.
 */
function redis_pipeline($commands) {
    global $redis_url, $redis_token;
    
    $payload = json_encode($commands);
    $url = "$redis_url/pipeline";
    
    $opts = [
        'http' => [
            'method'  => 'POST',
            'header'  => "Authorization: Bearer $redis_token\r\nContent-Type: application/json\r\n",
            'content' => $payload,
            'timeout' => 5,
            'ignore_errors' => true
        ],
        'ssl' => [
            'verify_peer' => false,
            'verify_peer_name' => false
        ]
    ];
    
    $context = stream_context_create($opts);
    $res = @file_get_contents($url, false, $context);
    
    if ($res === false) {
        if (function_exists('curl_init')) {
            $ch = curl_init($url);
            curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
            curl_setopt($ch, CURLOPT_POST, true);
            curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
            curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
            curl_setopt($ch, CURLOPT_TIMEOUT, 5);
            curl_setopt($ch, CURLOPT_HTTPHEADER, [
                "Authorization: Bearer $redis_token",
                "Content-Type: application/json"
            ]);
            $res = curl_exec($ch);
            curl_close($ch);
        }
        if (!$res) return [];
    }
    
    return json_decode($res, true) ?? [];
}

/**
 * Parse a Redis HGETALL flat array into an associative array.
 * HGETALL returns ["f1","v1","f2","v2",...] → ["f1"=>"v1","f2"=>"v2",...]
 */
function redis_parse_hash($data) {
    $parsed = [];
    if (is_array($data)) {
        for ($i = 0; $i < count($data); $i += 2) {
            $parsed[$data[$i]] = $data[$i + 1];
        }
    }
    return $parsed;
}

// ──────────────────────────────────────────────
//  PLAN CONFIGURATION
// ──────────────────────────────────────────────

/**
 * Plan → Max concurrent slots (reduced for shared runner model).
 */
function getSlotsForPlan($plan) {
    $map = [
        'starter'      => 1,
        'developer'    => 1,
        'professional' => 2,
        'studio'       => 3
    ];
    return $map[$plan] ?? 1;
}

/**
 * Plan → Time limits in seconds.
 *   session = max duration per boot (user must manually renew)
 *   weekly  = total hosting seconds allowed per rolling 7-day window
 */
function getPlanLimits($plan) {
    $limits = [
        'starter'      => ['session' => 3600,  'weekly' => 36000],   // 1h / 10h
        'developer'    => ['session' => 10800, 'weekly' => 86400],   // 3h / 24h
        'professional' => ['session' => 10800, 'weekly' => 86400],   // 3h / 24h
        'studio'       => ['session' => 21600, 'weekly' => 108000],  // 6h / 30h
    ];
    return $limits[$plan] ?? $limits['starter'];
}

/**
 * Plan → Storage quota in bytes.
 */
function getStorageQuota($plan) {
    $map = [
        'starter'      => 500 * 1024 * 1024,           // 500 MB
        'developer'    => 50 * 1024 * 1024 * 1024,      // 50 GB
        'professional' => 200 * 1024 * 1024 * 1024,     // 200 GB
        'studio'       => 1024 * 1024 * 1024 * 1024,    // 1 TB
    ];
    return $map[$plan] ?? $map['starter'];
}

// ──────────────────────────────────────────────
//  WEEKLY USAGE TRACKING
// ──────────────────────────────────────────────

/**
 * Get weekly usage for a specific user slot.
 * Automatically resets if 7 days have elapsed since week_start.
 *
 * @return array ['weekly_seconds' => int, 'week_start' => int (epoch)]
 */
function getWeeklyUsage($username, $site_id) {
    $key = "usage:{$username}_{$site_id}";
    $data = redis_cmd(["HGETALL", $key]);
    $parsed = redis_parse_hash($data);

    if (empty($parsed)) {
        // First time — initialise
        $now = time();
        redis_cmd(["HSET", $key, "weekly_seconds", "0", "week_start", (string)$now]);
        return ['weekly_seconds' => 0, 'week_start' => $now];
    }

    $week_start     = intval($parsed['week_start'] ?? time());
    $weekly_seconds = intval($parsed['weekly_seconds'] ?? 0);

    // Rolling 7-day window: reset if ≥ 604800 seconds have passed
    if (time() - $week_start >= 604800) {
        $now = time();
        redis_cmd(["HSET", $key, "weekly_seconds", "0", "week_start", (string)$now]);
        return ['weekly_seconds' => 0, 'week_start' => $now];
    }

    return ['weekly_seconds' => $weekly_seconds, 'week_start' => $week_start];
}
?>
