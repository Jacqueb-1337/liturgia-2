<?php
header('Content-Type: application/json');
require_once __DIR__ . '/db.php';

function getBearerToken(){
  $hdr = null;
  foreach (getallheaders() as $k=>$v) { if (strtolower($k) === 'authorization') { $hdr = $v; break; } }
  if ($hdr && preg_match('/Bearer\s+(\S+)/', $hdr, $m)) return $m[1];
  if (!empty($_POST['token'])) return $_POST['token'];
  if (!empty($_GET['token'])) return $_GET['token'];
  return null;
}

$auth = getBearerToken();
if (!$auth) { http_response_code(400); echo json_encode(['ok'=>false,'error'=>'no-token']); exit; }
$payload = decode_jwt_payload($auth);
$email = null; $status = null;
// If we have a JWT, try to use license-status (authoritative)
if ($payload && !empty($payload['email'])) {
  $email = $payload['email'];
  try {
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $url = $scheme . '://' . $_SERVER['HTTP_HOST'] . dirname($_SERVER['SCRIPT_NAME']) . '/license-status.php';
    $opts = ['http'=>['method'=>'GET','header'=>"Authorization: Bearer $auth\r\n",'timeout'=>3]];
    $ctx = stream_context_create($opts);
    $res = @file_get_contents($url, false, $ctx);
    if ($res) { $j = json_decode($res, true); if ($j) $status = $j; }
  } catch (Exception $e) { }
}
// Fallback: check DB accounts table using email derived from JWT or device token
if (!$status) {
  if (!$email) $email = email_from_auth_token($auth);
  if ($email) {
    $s = get_account_summary_for($email);
    if ($s) $status = $s;
  }
}
// If we still don't have billing info, attempt to include founder flag from users table
if (!$status) {
  try {
    $pdo = get_db();
    $stmt = $pdo->prepare('SELECT founder FROM users WHERE email = :email LIMIT 1');
    $stmt->execute([':email'=>$email]);
    $r = $stmt->fetch(PDO::FETCH_ASSOC);
    if ($r) $status = ['plan'=>'token','expires_at'=>null,'active'=>true,'founder'=>!empty($r['founder'])];
  } catch (Exception $e) { /* ignore */ }
}

if ($status) echo json_encode(['ok'=>true,'status'=>$status]); else echo json_encode(['ok'=>false]);
