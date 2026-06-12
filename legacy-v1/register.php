<?php
require 'db.php';
header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    echo json_encode(["success" => false, "message" => "Invalid request"]);
    exit;
}

$username = trim($_POST['username'] ?? '');
$password = trim($_POST['password'] ?? '');

if (strlen($username) < 3 || strlen($password) < 4) {
    echo json_encode(["success" => false, "message" => "Username (3+ chars) and password (4+ chars) required"]);
    exit;
}

$username = preg_replace('/[^a-zA-Z0-9-]/', '', $username);

// Check if user already exists
$stmt = $conn->prepare("SELECT id FROM users WHERE username = ?");
$stmt->bind_param("s", $username);
$stmt->execute();
if ($stmt->get_result()->num_rows > 0) {
    echo json_encode(["success" => false, "message" => "Username already taken"]);
    $stmt->close();
    exit;
}
$stmt->close();

// Create user with hashed password
$hashed = password_hash($password, PASSWORD_DEFAULT);
$stmt = $conn->prepare("INSERT INTO users (username, password, plan) VALUES (?, ?, 'starter')");
$stmt->bind_param("ss", $username, $hashed);

if ($stmt->execute()) {
    echo json_encode(["success" => true, "message" => "Account created"]);
} else {
    echo json_encode(["success" => false, "message" => "Registration failed"]);
}
$stmt->close();
$conn->close();
?>
