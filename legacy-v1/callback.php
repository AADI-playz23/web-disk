<?php
// ── Callback for GitHub Actions to update slot status ──
// POST callback.php  { username, site_id, status, url }
require 'db.php';
header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    echo json_encode(["error" => "POST only"]);
    exit;
}

$username = preg_replace('/[^a-zA-Z0-9-]/', '', $_POST['username'] ?? '');
$site_id = intval($_POST['site_id'] ?? 0);
$status = $_POST['status'] ?? '';
$url = $_POST['url'] ?? '';

if (empty($username) || $site_id < 1 || !in_array($status, ['offline','booting','live'])) {
    echo json_encode(["error" => "Invalid params"]);
    exit;
}

$stmt = $conn->prepare("INSERT INTO slots (username, site_id, status, url) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE status = VALUES(status), url = VALUES(url)");
$stmt->bind_param("siss", $username, $site_id, $status, $url);

if ($stmt->execute()) {
    echo json_encode(["success" => true]);
} else {
    echo json_encode(["error" => "DB update failed"]);
}
$stmt->close();
$conn->close();
?>
