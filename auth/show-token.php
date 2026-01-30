<?php
require_once __DIR__ . '/_helpers.php';
header('Content-Type: application/json; charset=utf-8');

$id = isset($_GET['id']) ? trim($_GET['id']) : null;
$auth = get_raw_token();
if (!$id) json_err(400, 'missing id');
if (!$auth) json_err(401, 'no auth');

// locate token by id and ensure caller owns it
$all = load_tokens();
foreach ($all as $t) {
    if ($t['id'] === $id) {
        // only return the raw token once: if token already revealed, return 403
        if (!empty($t['revealed'])) json_err(403, 'token shown only once');
        // ensure caller owns it
        $payload = decode_jwt_payload($auth);
        $email = $payload['email'] ?? null;
        if (!$email && !empty($auth)) {
            foreach ($all as $x) { if (!empty($x['token']) && hash_equals($x['token'], $auth)) { $email = $x['email']; break; } }
        }
        if (!$email || $email !== ($t['email'] ?? null)) json_err(401, 'unauthorized');
        // mark revealed and return token
        foreach ($all as &$m) { if ($m['id'] === $id) { $m['revealed'] = now_iso(); save_tokens($all); break; } }
        json_ok(['token' => $t['token']]);
    }
}
json_err(404, 'not found');
