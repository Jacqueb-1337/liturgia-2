<?php
require_once __DIR__ . '/_helpers.php';
header('Content-Type: application/json; charset=utf-8');

$token = get_raw_token();
$label = isset($_POST['label']) ? trim($_POST['label']) : (isset($_GET['label']) ? trim($_GET['label']) : '');
$device = isset($_POST['device']) ? trim($_POST['device']) : (isset($_GET['device']) ? trim($_GET['device']) : '');
if (!$token) json_err(401, 'no token');

// identify email
$payload = decode_jwt_payload($token);
$email = $payload['email'] ?? null;
if (!$email) {
    // try to match against stored tokens (token may be id.secret)
    $all = load_tokens();
    foreach ($all as $t) {
        if (!empty($t['revoked_at'])) continue;
        if (!empty($t['token']) && hash_equals($t['token'], $token)) { $email = $t['email']; break; }
    }
}
if (!$email) json_err(401, 'unauthorized');

// create new token: id.secret format and store whole token for simplicity (not hashed — rotate later)
$id = bin2hex(random_bytes(8));
$secret = generate_secret();
$full = $id . '.' . $secret;
$entry = [ 'id' => $id, 'email' => $email, 'label' => $label, 'device' => $device, 'token' => $full, 'created_at' => now_iso(), 'last_seen' => null ];
$all = load_tokens();
$all[] = $entry; save_tokens($all);

json_ok(['token' => $full, 'id' => $id, 'label' => $label]);
