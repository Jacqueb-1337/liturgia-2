<?php
require_once __DIR__ . '/auth/_helpers.php';
header('Content-Type: application/json; charset=utf-8');

$token = get_raw_token();
if (!$token) json_err(401, 'no token');

// First, attempt to decode JWT and return best-effort status
$payload = decode_jwt_payload($token);
if ($payload && !empty($payload['email'])) {
    $email = $payload['email'];
    $status = [ 'email' => $email, 'plan' => 'token', 'active' => true ];
    if (!empty($payload['exp'])) $status['expires_at'] = intval($payload['exp']);
    // if possible, try to enrich from tokens.json (subscription flags like founder)
    $all = load_tokens();
    foreach ($all as $t) {
        if (!empty($t['email']) && $t['email'] === $email && !empty($t['founder'])) { $status['founder'] = true; break; }
    }
    echo json_encode($status);
    exit;
}

// Not a JWT: attempt to find persistent token in tokens.json
$all = load_tokens();
foreach ($all as $t) {
    if (!empty($t['token']) && hash_equals($t['token'], $token)) {
        $status = ['email' => $t['email'] ?? null, 'plan' => ($t['plan'] ?? 'token'), 'active' => true, 'expires_at' => ($t['expires_at'] ?? null)];
        echo json_encode($status);
        exit;
    }
}

json_err(401, 'invalid token');
