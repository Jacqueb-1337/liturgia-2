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
$id = isset($_GET['id']) ? $_GET['id'] : null;
if (!$id) { http_response_code(400); echo json_encode(['error'=>'missing-id']); exit; }
// Attempt to reveal the token if it hasn't been revealed yet and caller is authorized
$revealed = reveal_token_by_id($email, $id);
if ($revealed) {
  echo json_encode(['ok'=>true,'token'=>$revealed]);
} else {
  // If there is no hidden raw secret (either it's already revealed, doesn't exist, or caller not owner), return 403
  http_response_code(403);
  echo json_encode(['error'=>'token_not_retrievable','message'=>'Token not retrievable or already revealed.']);
}
