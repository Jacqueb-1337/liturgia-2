<?php
require_once __DIR__ . '/_helpers.php';

// List tokens associated with the provided token (JWT or stored persistent token)
header('Content-Type: application/json; charset=utf-8');
$token = get_raw_token();
if (!$token) json_err(401, 'no token');

// If it's a JWT, return a synthetic session that represents the magic-link
$payload = decode_jwt_payload($token);
if ($payload && !empty($payload['email'])) {
    $email = $payload['email'];
    $ts = now_iso();
    $entry = [
        'id' => 'magiclink-' . substr(hash('sha256', $token), 0, 12),
        'label' => 'Magic link',
        'device' => 'email',
        'email' => $email,
        'created_at' => $ts,
        'last_seen' => $ts,
    ];
    json_ok(['tokens' => [$entry]]);
}

// Otherwise try persisted tokens.json
$all = load_tokens();
// try to match by raw token id.secret format
// check for id.secret exact match
$parts = explode('.', $token); // not a token id, just to avoid warnings
// find if this token directly matches one of stored secrets (we store id.secret)
$matches = [];
foreach ($all as $t) {
    if (!empty($t['revoked_at'])) continue;
    if (!empty($t['token']) && hash_equals($t['token'], $token)) {
        $matches[] = $t; break;
    }
}
if (!empty($matches)) {
    $email = $matches[0]['email'] ?? null;
    // return all tokens for that user
    $out = find_tokens_for_email($email);
    json_ok(['tokens' => array_values($out)]);
}

// fallback: no matches
json_err(401, 'invalid or expired token');
