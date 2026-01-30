<?php
require_once __DIR__ . '/db.php';
header('Content-Type: application/json; charset=utf-8');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') { http_response_code(405); echo json_encode(['ok'=>false,'error'=>'method']); exit; }
$email = isset($_POST['email']) ? trim($_POST['email']) : (isset($_GET['email']) ? trim($_GET['email']) : null);
if (!$email || !filter_var($email, FILTER_VALIDATE_EMAIL)) { http_response_code(400); echo json_encode(['ok'=>false,'error'=>'invalid-email']); exit; }

// Create a persistent device token for the magic link (id.secret) and send it by email.
$label = 'Magic link';
$device = 'email';
$res = create_token_for($email, $label, $device);
if (!$res) { http_response_code(500); echo json_encode(['ok'=>false,'error'=>'failed']); exit; }
$token = $res['token'];
// Build magic URL (site should accept token= or Authorization header)
$scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
$base = $scheme . '://' . $_SERVER['HTTP_HOST'] . rtrim(dirname($_SERVER['SCRIPT_NAME']), '/');
$magicUrl = $base . '/?token=' . urlencode($token);

// Send a simple email (use mail() - replace with your mailer in production)
$subject = 'Your Liturgia sign-in link';
$body = "Sign in to Liturgia: $magicUrl\n\nOr use this token directly: $token\n\nThis token is persistent and can be revoked from your account.";
$headers = 'From: no-reply@' . $_SERVER['HTTP_HOST'];
@mail($email, $subject, $body, $headers);

echo json_encode(['ok'=>true,'message'=>'sent']);
