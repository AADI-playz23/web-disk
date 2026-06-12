<?php
require 'db.php';

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $username = preg_replace('/[^a-zA-Z0-9-]/', '', $_POST['username']);
    $plan = preg_replace('/[^a-zA-Z]/', '', $_POST['plan']);
    $txnid = preg_replace('/[^a-zA-Z0-9]/', '', $_POST['txnid']);

    // 1. Upload Proof to GitHub
    $fileTmpPath = $_FILES['screenshot']['tmp_name'];
    $base64Content = base64_encode(file_get_contents($fileTmpPath));
    $git_path = "payments/{$username}_{$plan}_{$txnid}.jpg";

    $upload_url = "https://api.github.com/repos/$owner/$repo_storage/contents/$git_path";
    $ch = curl_init($upload_url);
    curl_setopt($ch, CURLOPT_HTTPHEADER, ["Authorization: token $github_token", "User-Agent: Absora-API", "Accept: application/vnd.github.v3+json"]);
    curl_setopt($ch, CURLOPT_CUSTOMREQUEST, "PUT");
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode(["message" => "Payment Proof: $username", "content" => $base64Content]));
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
    curl_exec($ch); curl_close($ch);

    // 2. Update plan in MySQL
    $stmt = $conn->prepare("UPDATE users SET plan = ? WHERE username = ?");
    $stmt->bind_param("ss", $plan, $username);
    $stmt->execute();
    $stmt->close();

    // 3. Trigger Auto Upgrade workflow
    $upgrade_url = "https://api.github.com/repos/$owner/$repo_engine/actions/workflows/upgrade.yml/dispatches";
    $ch2 = curl_init($upgrade_url);
    curl_setopt($ch2, CURLOPT_HTTPHEADER, ["Authorization: token $github_token", "User-Agent: Absora-API", "Accept: application/vnd.github.v3+json"]);
    curl_setopt($ch2, CURLOPT_POST, 1);
    curl_setopt($ch2, CURLOPT_POSTFIELDS, json_encode(["ref" => "main", "inputs" => ["username" => $username, "plan" => $plan]]));
    curl_setopt($ch2, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch2, CURLOPT_SSL_VERIFYPEER, false);
    $res = curl_exec($ch2); $code = curl_getinfo($ch2, CURLINFO_HTTP_CODE); curl_close($ch2);

    if ($code == 204) echo "Success! Your plan is being upgraded. Please wait 60 seconds.";
    else echo "Proof received, but upgrade engine failed. Contact Admin.";
}
$conn->close();
?>