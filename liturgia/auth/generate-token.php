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
if (!$auth) { http_response_code(401); echo json_encode(['error'=>'no-token']); exit; }
// derive email - supports JWT or device token
$email = email_from_auth_token($auth);
if (!$email) { http_response_code(401); echo json_encode(['error'=>'invalid-token']); exit; }
$label = isset($_POST['label']) ? trim($_POST['label']) : '';
$device = isset($_POST['device']) ? trim($_POST['device']) : '';
// create token in DB (hashed); return raw token once
$res = create_token_for($email, $label, $device);
if ($res && isset($res['token'])) {
  echo json_encode(['ok'=>true, 'token'=>$res['token'], 'id'=>$res['id']]);
} else {
  http_response_code(500); echo json_encode(['error'=>'failed']);
}

