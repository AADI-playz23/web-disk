<?php
// ══════════════════════════════════════════════
//  ABSORA SETUP SCRIPT — Run this ONCE
//  Visit: https://abwebhost.rf.gd/setup.php
// ══════════════════════════════════════════════
require 'db.php';
header('Content-Type: text/html; charset=utf-8');

echo "<html><body style='background:#030712;color:#fff;font-family:sans-serif;padding:40px;'>";
echo "<h1>🔧 Absora Setup</h1>";

// 1. Test MySQL
echo "<h2>1. MySQL Connection</h2>";
if ($conn->connect_error) {
    echo "<p style='color:red;'>❌ MySQL FAILED: " . $conn->connect_error . "</p>";
} else {
    echo "<p style='color:#10b981;'>✅ MySQL connected</p>";
}

// 2. Database Schema
echo "<h2>2. Database Schema</h2>";

// Ensure slots table exists
$conn->query("CREATE TABLE IF NOT EXISTS slots (
    username VARCHAR(50) NOT NULL,
    site_id INT NOT NULL,
    status VARCHAR(20) DEFAULT 'offline',
    url TEXT DEFAULT NULL,
    PRIMARY KEY (username, site_id)
)");
echo "<p style='color:#10b981;'>✅ slots table exists</p>";

// Ensure users table exists
$check = $conn->query("SHOW TABLES LIKE 'users'");
if ($check && $check->num_rows > 0) {
    echo "<p style='color:#10b981;'>✅ users table exists</p>";
} else {
    echo "<p style='color:red;'>❌ users table missing!</p>";
}

// 3. Test Redis connection
echo "<h2>3. Redis (Upstash) Connection</h2>";
$test = redis_cmd(["PING"]);
if ($test === "PONG") {
    echo "<p style='color:#10b981;'>✅ Redis connected — PONG received</p>";
} else {
    echo "<p style='color:orange;'>⚠️ Redis returned: " . json_encode($test) . "</p>";
    
    // Try raw test
    $opts = [
        'http' => [
            'method' => 'POST',
            'header' => "Authorization: Bearer $redis_token\r\nContent-Type: application/json\r\n",
            'content' => json_encode(["PING"]),
            'timeout' => 10,
            'ignore_errors' => true
        ],
        'ssl' => ['verify_peer' => false, 'verify_peer_name' => false]
    ];
    $ctx = stream_context_create($opts);
    $raw = @file_get_contents($redis_url, false, $ctx);
    
    if ($raw === false) {
        echo "<p style='color:orange;'>⚠️ file_get_contents to Redis failed</p>";
        
        // Try curl
        if (function_exists('curl_init')) {
            echo "<p>Trying curl...</p>";
            $ch = curl_init($redis_url);
            curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
            curl_setopt($ch, CURLOPT_POST, true);
            curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode(["PING"]));
            curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
            curl_setopt($ch, CURLOPT_TIMEOUT, 10);
            curl_setopt($ch, CURLOPT_HTTPHEADER, [
                "Authorization: Bearer $redis_token",
                "Content-Type: application/json"
            ]);
            $cres = curl_exec($ch);
            $cerr = curl_error($ch);
            curl_close($ch);
            
            if ($cres) {
                echo "<p style='color:#10b981;'>✅ curl works! Response: $cres</p>";
            } else {
                echo "<p style='color:red;'>❌ curl also failed: $cerr</p>";
            }
        } else {
            echo "<p style='color:red;'>❌ curl not available</p>";
        }
    } else {
        echo "<p style='color:#10b981;'>✅ Raw response: $raw</p>";
    }
}

// 4. Test GitHub API
echo "<h2>4. GitHub API</h2>";
$ch = curl_init("https://api.github.com/repos/$owner/$repo_engine");
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    "Authorization: token $github_token",
    "Accept: application/vnd.github.v3+json",
    "User-Agent: AbsoraCloud"
]);
curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
$ghres = curl_exec($ch);
curl_close($ch);
$ghdata = json_decode($ghres, true);
if (isset($ghdata['name'])) {
    echo "<p style='color:#10b981;'>✅ GitHub repo accessible: " . $ghdata['full_name'] . "</p>";
} else {
    echo "<p style='color:red;'>❌ GitHub error: " . ($ghdata['message'] ?? 'unknown') . "</p>";
}

echo "<hr style='border-color:#1f2937;'>";
echo "<p style='color:#9ca3af;'>Delete this file after setup is complete!</p>";
echo "</body></html>";

$conn->close();
?>
