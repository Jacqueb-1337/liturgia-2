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
$email = email_from_auth_token($auth);
if (!$email) { http_response_code(401); echo json_encode(['error'=>'invalid-token']); exit; }
$id = isset($_POST['id']) ? $_POST['id'] : null;
if (!$id) { http_response_code(400); echo json_encode(['error'=>'missing-id']); exit; }
$ok = revoke_token_for($email, $id);
echo json_encode(['ok'=>$ok]);
