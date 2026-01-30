<?php
// Shared helpers for auth endpoints
function get_request_headers() {
    if (function_exists('getallheaders')) return getallheaders();
    $headers = [];
    foreach ($_SERVER as $k => $v) {
        if (strpos($k, 'HTTP_') === 0) {
            $name = str_replace(' ', '-', ucwords(strtolower(str_replace('_', ' ', substr($k, 5)))));
            $headers[$name] = $v;
        }
    }
    if (isset($_SERVER['CONTENT_TYPE'])) $headers['Content-Type'] = $_SERVER['CONTENT_TYPE'];
    if (isset($_SERVER['CONTENT_LENGTH'])) $headers['Content-Length'] = $_SERVER['CONTENT_LENGTH'];
    return $headers;
}

function get_raw_token() {
    $all = get_request_headers();
    foreach ($all as $k => $v) {
        if (strtolower($k) === 'authorization') {
            if (preg_match('#Bearer\s+(\S+)#i', $v, $m)) return $m[1];
        }
    }
    if (!empty($_GET['token'])) return $_GET['token'];
    if (!empty($_POST['token'])) return $_POST['token'];
    return null;
}

function json_ok($data) {
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(array_merge(['ok'=>true], $data));
    exit;
}
function json_err($code, $msg) {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok'=>false, 'error'=>$msg]);
    exit;
}

function decode_jwt_payload($token) {
    if (!$token || substr_count($token, '.') !== 2) return null;
    $parts = explode('.', $token);
    $b64 = $parts[1];
    $b64 = str_replace(['-','_'], ['+','/'], $b64);
    switch (strlen($b64) % 4) { case 2: $b64 .= '=='; break; case 3: $b64 .= '='; break; case 0: break; default: $b64 .= str_repeat('=', 4 - (strlen($b64) % 4)); }
    $json = base64_decode($b64);
    if ($json === false) return null;
    $arr = json_decode($json, true);
    return is_array($arr) ? $arr : null;
}

function tokens_file_path() {
    return __DIR__ . '/tokens.json';
}

function load_tokens() {
    $f = tokens_file_path();
    if (!file_exists($f)) return [];
    $txt = @file_get_contents($f);
    if (!$txt) return [];
    $j = json_decode($txt, true);
    return is_array($j) ? $j : [];
}

function save_tokens($arr) {
    $f = tokens_file_path();
    $txt = json_encode($arr, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    file_put_contents($f, $txt, LOCK_EX);
}

function find_tokens_for_email($email) {
    $all = load_tokens();
    $out = [];
    foreach ($all as $t) {
        if (!empty($t['revoked_at'])) continue;
        if (isset($t['email']) && $t['email'] === $email) $out[] = $t;
    }
    return $out;
}

function require_token_or_die() {
    $t = get_raw_token();
    if (!$t) json_err(401, 'no token provided');
    return $t;
}

function generate_secret() {
    return bin2hex(random_bytes(12));
}

function now_iso() { return date('c'); }
