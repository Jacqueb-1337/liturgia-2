<?php
require __DIR__.'/helpers.php';
require __DIR__.'/db.php';
// include auth token helpers (DB-backed tokens)
require_once __DIR__ . '/auth/db.php';

// Robust token extraction and enhanced debugging for hosts that strip Authorization header
$headers = [];
if (function_exists('getallheaders')) {
    $headers = getallheaders();
}
// Also capture server-based authorization keys which some proxies populate
$server_auth = [
    'HTTP_AUTHORIZATION' => $_SERVER['HTTP_AUTHORIZATION'] ?? null,
    'REDIRECT_HTTP_AUTHORIZATION' => $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? null,
];
$auth_header = $headers['Authorization'] ?? $headers['authorization'] ?? $server_auth['HTTP_AUTHORIZATION'] ?? $server_auth['REDIRECT_HTTP_AUTHORIZATION'] ?? null;
$raw_input = file_get_contents('php://input');
@file_put_contents(__DIR__.'/data/auth.log', date('c') . " - Authorization header: " . ($auth_header ? $auth_header : '<none>') . "\n", FILE_APPEND);
@file_put_contents(__DIR__.'/data/auth.log', date('c') . " - Headers: " . json_encode($headers) . "\n", FILE_APPEND);
@file_put_contents(__DIR__.'/data/auth.log', date('c') . " - Server auth keys: " . json_encode($server_auth) . "\n", FILE_APPEND);
@file_put_contents(__DIR__.'/data/auth.log', date('c') . " - GET keys: " . json_encode(array_keys($_GET)) . "\n", FILE_APPEND);
@file_put_contents(__DIR__.'/data/auth.log', date('c') . " - POST keys: " . json_encode(array_keys($_POST)) . "\n", FILE_APPEND);
@file_put_contents(__DIR__.'/data/auth.log', date('c') . " - raw input (first 1000 chars): " . substr($raw_input,0,1000) . "\n", FILE_APPEND);

$jwt = null;
$token_source = null;
// 1) prefer Authorization header
if ($auth_header && stripos($auth_header, 'Bearer ') === 0) {
    $jwt = substr($auth_header, 7);
    $token_source = 'Authorization header';
    @file_put_contents(__DIR__.'/data/auth.log', date('c') . " - Token from Authorization header\n", FILE_APPEND);
}
// 2) fallback to GET token
if (!$jwt && isset($_GET['token'])) {
    $jwt = $_GET['token'];
    $token_source = 'GET param';
    @file_put_contents(__DIR__.'/data/auth.log', date('c') . " - Token from GET param\n", FILE_APPEND);
}
// 3) fallback to POST form token
if (!$jwt && isset($_POST['token'])) {
    $jwt = $_POST['token'];
    $token_source = 'POST form';
    @file_put_contents(__DIR__.'/data/auth.log', date('c') . " - Token from POST form\n", FILE_APPEND);
}
// 4) fallback to JSON body
if (!$jwt && $raw_input) {
    $maybe = json_decode($raw_input, true);
    if (is_array($maybe) && isset($maybe['token'])) {
        $jwt = $maybe['token'];
        $token_source = 'JSON body';
        @file_put_contents(__DIR__.'/data/auth.log', date('c') . " - Token from JSON body\n", FILE_APPEND);
    } else {
        @file_put_contents(__DIR__.'/data/auth.log', date('c') . " - JSON parse failed or no token key\n", FILE_APPEND);
    }
}

if (!$jwt) {
    http_response_code(401);
    echo json_encode(['error'=>'Missing token']);
    exit;
}

$decoded = jwt_decode_token($jwt);
@file_put_contents(__DIR__.'/data/auth.log', date('c') . " - JWT decode: " . json_encode($decoded) . "\n", FILE_APPEND);
@file_put_contents(__DIR__.'/data/auth.log', date('c') . " - token_source: " . ($token_source ?: '<unknown>') . "\n", FILE_APPEND);
if (!$decoded) {
    @file_put_contents(__DIR__.'/data/auth.log', date('c') . " - JWT not decoded; attempting device token lookup\n", FILE_APPEND);
    $row = token_row_from_raw($jwt);
    if ($row && !empty($row['email'])) {
        $email = $row['email'];
        @file_put_contents(__DIR__.'/data/auth.log', date('c') . " - Device token matched for email={$email}\n", FILE_APPEND);
        // lookup user by email in main users table
        $stmt2 = $pdo->prepare('SELECT id, email, active, plan, expires_at FROM users WHERE email = :email LIMIT 1');
        $stmt2->execute([':email'=>$email]);
        $u2 = $stmt2->fetch(PDO::FETCH_ASSOC);
        if ($u2) {
            header('Content-Type: application/json');
            echo json_encode(['active'=>(bool)$u2['active'],'plan'=>$u2['plan'],'expires_at'=>$u2['expires_at'],'email'=>$u2['email']]);
            exit;
        } else {
            // If no user row, try auth accounts table fallback
            $s = get_account_summary_for($email);
            if ($s) { header('Content-Type: application/json'); echo json_encode(['active'=>!!$s['active'],'plan'=>$s['plan'],'expires_at'=>$s['expires_at'],'email'=>$email]); exit; }
            http_response_code(401); echo json_encode(['error'=>'Invalid token']); exit;
        }
    }

    @file_put_contents(__DIR__.'/data/auth.log', date('c') . " - Token invalid or expired\n", FILE_APPEND);
    http_response_code(401);
    echo json_encode(['error'=>'Invalid token']);
    exit;
}
$uid = $decoded['sub'];
$pdo = get_db();
// DB debug: resolve DB_PATH and run quick checks (PRAGMA for sqlite and users count)
$db_path_env = getenv('DB_PATH') ?: null;
// Resolve relative paths when possible
$db_path_resolved = null;
if ($db_path_env) {
    $candidate = $db_path_env;
    if (strpos($candidate, '/') !== 0 && strpos($candidate, ':') === false) {
        $candidate = __DIR__ . '/' . $candidate;
    }
    $db_path_resolved = realpath($candidate) ?: $candidate;
}
@file_put_contents(__DIR__.'/data/auth.log', date('c') . " - DB_PATH env: " . ($db_path_env ?: '<none>') . " resolved: " . ($db_path_resolved ?: '<none>') . "\n", FILE_APPEND);
$db_check = [];
try {
    $stmt = $pdo->query("PRAGMA database_list");
    if ($stmt) $db_check['database_list'] = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $stmt = $pdo->query("SELECT count(*) as cnt FROM users");
    if ($stmt) $db_check['users_count'] = intval($stmt->fetch(PDO::FETCH_ASSOC)['cnt'] ?? 0);
    $stmt = $pdo->query("PRAGMA table_info('users')");
    if ($stmt) $db_check['users_table_info'] = $stmt->fetchAll(PDO::FETCH_ASSOC);
} catch (Exception $e) {
    $db_check['error'] = $e->getMessage();
}
@file_put_contents(__DIR__.'/data/auth.log', date('c') . " - DB check: " . json_encode($db_check) . "\n", FILE_APPEND);

$stmt = $pdo->prepare('SELECT id, email, active, plan, expires_at, founder FROM users WHERE id = :id LIMIT 1');
$stmt->execute([':id'=>$uid]);
$st_err = $stmt->errorInfo();
@file_put_contents(__DIR__.'/data/auth.log', date('c') . " - stmt errorInfo: " . json_encode($st_err) . "\n", FILE_APPEND);
@file_put_contents(__DIR__.'/data/auth.log', date('c') . " - uid type: " . gettype($uid) . " repr: " . var_export($uid, true) . "\n", FILE_APPEND);
$u = $stmt->fetch(PDO::FETCH_ASSOC);
@file_put_contents(__DIR__.'/data/auth.log', date('c') . " - DB lookup for uid {$uid}: " . json_encode($u) . "\n", FILE_APPEND);
// Fallback: run a raw query using integer cast
try {
    $raw = $pdo->query('SELECT id, email, active, plan, expires_at FROM users WHERE id = '.intval($uid).' LIMIT 1');
    $rawu = $raw ? $raw->fetch(PDO::FETCH_ASSOC) : null;
    @file_put_contents(__DIR__.'/data/auth.log', date('c') . " - raw query result: " . json_encode($rawu) . "\n", FILE_APPEND);
} catch (Exception $e) {
    @file_put_contents(__DIR__.'/data/auth.log', date('c') . " - raw query error: " . $e->getMessage() . "\n", FILE_APPEND);
}
@file_put_contents(__DIR__.'/data/auth.log', date('c') . " - PDO errorInfo: " . json_encode($pdo->errorInfo()) . "\n", FILE_APPEND);
if (!$u) {
    if (isset($_GET['debug']) && $_GET['debug'] === '1') {
        // Additional checks from this request's DB connection
        $users_count_q = null;
        $users_sample = null;
        $user_by_id = null;
        try {
            $users_count_q = $pdo->query('SELECT count(*) AS cnt FROM users')->fetch(PDO::FETCH_ASSOC);
            $users_sample = $pdo->query('SELECT id, email, active, plan, expires_at FROM users LIMIT 10')->fetchAll(PDO::FETCH_ASSOC);
            $sth = $pdo->prepare('SELECT * FROM users WHERE id = :id LIMIT 1');
            $sth->execute([':id'=>$uid]);
            $user_by_id = $sth->fetch(PDO::FETCH_ASSOC);
        } catch (Exception $e) {
            $users_count_q = ['error'=>$e->getMessage()];
        }
        $db_file_stats = null;
        if ($db_path_resolved && file_exists($db_path_resolved)) {
            $db_file_stats = ['size'=>filesize($db_path_resolved), 'mtime'=>filemtime($db_path_resolved)];
        }
        $proc = ['php_sapi'=>php_sapi_name(), 'php_uname'=>php_uname(), 'pid'=>getmypid(), 'uid'=>function_exists('posix_geteuid') ? posix_geteuid() : null];
        if (function_exists('posix_getpwuid') && $proc['uid']) { $proc['user'] = posix_getpwuid($proc['uid']); }
        @file_put_contents(__DIR__.'/data/auth.log', date('c') . " - process_info: " . json_encode($proc) . "\n", FILE_APPEND);
        http_response_code(404);
        echo json_encode([
            'error'=>'User not found',
            'attempted_uid'=>$uid,
            'token_payload'=>$decoded,
            'token_source'=>$token_source,
            'db_path_resolved'=>$db_path_resolved,
            'db_check'=>$db_check,
            'users_count'=>$users_count_q,
            'users_sample'=>$users_sample,
            'user_by_id'=>$user_by_id,
            'db_file_stats'=>$db_file_stats,
            'pdo_error'=>$pdo->errorInfo(),
            'process_info'=>$proc,
        ]);
        exit;
    }
    http_response_code(404); echo json_encode(['error'=>'User not found']); exit;
}
$active = (bool)$u['active'];
$expires = $u['expires_at'] ? (int)$u['expires_at'] : null;
header('Content-Type: application/json');
// If debug flag is present, also return decoded payload and request info
if (isset($_GET['debug']) && $_GET['debug'] === '1') {
    // sample rows from users table to inspect visibility
    $sample = [];
    try {
        $r = $pdo->query('SELECT id, email, active, plan, expires_at, founder FROM users LIMIT 50');
        if ($r) $sample = $r->fetchAll(PDO::FETCH_ASSOC);
    } catch (Exception $e) {
        $sample = ['error'=>$e->getMessage()];
    }
    $db_file_stats = null;
    if ($db_path_resolved && file_exists($db_path_resolved)) {
        $db_file_stats = ['size'=>filesize($db_path_resolved), 'mtime'=>filemtime($db_path_resolved)];
        $wal = $db_path_resolved . '-wal';
        $shm = $db_path_resolved . '-shm';
        $db_file_stats['wal'] = file_exists($wal) ? ['size'=>filesize($wal), 'mtime'=>filemtime($wal)] : null;
        $db_file_stats['shm'] = file_exists($shm) ? ['size'=>filesize($shm), 'mtime'=>filemtime($shm)] : null;
    }
    $proc = ['php_sapi'=>php_sapi_name(), 'php_uname'=>php_uname(), 'pid'=>getmypid(), 'uid'=>function_exists('posix_geteuid') ? posix_geteuid() : null];
    if (function_exists('posix_getpwuid') && $proc['uid']) { $proc['user'] = posix_getpwuid($proc['uid']); }
    $debug_out = ['active'=>$active, 'plan'=>$u['plan'], 'expires_at'=>$expires, 'founder'=>!empty($u['founder']), 'token_payload'=>$decoded, 'token_source'=>$token_source, 'headers'=>$headers, 'server_auth'=>$server_auth, 'raw_input'=>substr($raw_input,0,1000), 'user_row'=>$u, 'users_sample'=>$sample, 'db_file_stats'=>$db_file_stats, 'db_check'=>$db_check, 'process_info'=>$proc];
    echo json_encode($debug_out);
} else {
    echo json_encode(['active'=>$active, 'plan'=>$u['plan'], 'expires_at'=>$expires, 'founder'=>!empty($u['founder'])]);
}
?>