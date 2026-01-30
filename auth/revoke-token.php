<?php
require_once __DIR__ . '/_helpers.php';
header('Content-Type: application/json; charset=utf-8');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') json_err(405, 'method');
$auth = get_raw_token();
$id = isset($_POST['id']) ? trim($_POST['id']) : null;
if (!$auth || !$id) json_err(401, 'missing');

// find requestor email
$payload = decode_jwt_payload($auth);
$email = $payload['email'] ?? null;
if (!$email) {
    $all = load_tokens();
    foreach ($all as $t) { if (!empty($t['token']) && hash_equals($t['token'], $auth)) { $email = $t['email']; break; } }
}
if (!$email) json_err(401, 'unauthorized');

$all = load_tokens(); $found = false;
foreach ($all as &$t) {
    if ($t['id'] === $id && $t['email'] === $email && empty($t['revoked_at'])) { $t['revoked_at'] = now_iso(); $found = true; }
}

if ($found) { save_tokens($all); json_ok(['message'=>'revoked']); }
else json_err(404, 'not found');
