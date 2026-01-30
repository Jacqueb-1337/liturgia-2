<?php
header('Content-Type: application/json; charset=utf-8');

// Simple, resilient account summary endpoint.
// Accepts token via Authorization: Bearer <token> or ?token= or POST body 'token'.
// If a JWT is provided, decode payload (without verifying signature) and return best-effort account info.
// If no recognizable token is provided, returns 401.

function get_raw_token() {
    $hdr = null;
    foreach (getallheaders() as $k => $v) {
        if (strtolower($k) === 'authorization') { $hdr = $v; break; }
    }
    if ($hdr) {
        if (preg_match('#Bearer\s+(\S+)#i', $hdr, $m)) return $m[1];
    }
    if (!empty($_GET['token'])) return $_GET['token'];
    if (!empty($_POST['token'])) return $_POST['token'];
    return null;
}

function json_err($code, $msg) {
    http_response_code($code);
    echo json_encode(['ok'=>false, 'error'=>$msg]);
    exit;
}

$token = get_raw_token();
if (!$token) json_err(401, 'no token provided');

try {
    // If token looks like JWT (has two dots), decode payload without verifying signature.
    if (substr_count($token, '.') === 2) {
        $parts = explode('.', $token);
        $payload_b64 = $parts[1];
        $payload_b64 = str_replace(['-','_'], ['+','/'], $payload_b64);
        switch (strlen($payload_b64) % 4) {
            case 2: $payload_b64 .= '=='; break;
            case 3: $payload_b64 .= '='; break;
            case 0: break;
            default: $payload_b64 .= str_repeat('=', 4 - (strlen($payload_b64) % 4));
        }
        $json = base64_decode($payload_b64);
        if ($json !== false) {
            $obj = json_decode($json, true);
            if (is_array($obj)) {
                $email = isset($obj['email']) ? $obj['email'] : (isset($obj['sub']) ? $obj['sub'] : null);
                $exp = isset($obj['exp']) ? intval($obj['exp']) : null;
                $status = [
                    'email' => $email,
                    'plan' => 'token',
                    'active' => true,
                ];
                if ($exp) $status['expires_at'] = $exp;
                echo json_encode(['ok'=>true, 'status' => $status]);
                exit;
            }
        }
        // fallthrough to try other strategies
    }

    // Not a JWT or decoding failed. If we had server-side DB code, we'd look up token here.
    // For now, be explicit and return 401 rather than a 500.
    json_err(401, 'unsupported token format or token invalid');
} catch (Exception $e) {
    error_log('account-summary error: ' . $e->getMessage());
    json_err(500, 'internal error');
}
