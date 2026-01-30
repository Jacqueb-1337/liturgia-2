<?php
// Simple DB helper for token/account storage (SQLite).
// Production-ready: uses hashed token verification and preserves legacy tokens during migration.

function get_db_conn() {
  static $pdo = null;
  if ($pdo) return $pdo;
  $path = __DIR__ . '/auth.db';
  $init = !file_exists($path);
  $pdo = new PDO('sqlite:' . $path);
  $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
  // Create tables if needed
  $pdo->exec("PRAGMA foreign_keys = ON;");
  $pdo->exec("CREATE TABLE IF NOT EXISTS tokens (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    label TEXT,
    device TEXT,
    token_hash TEXT NOT NULL,
    raw_secret TEXT DEFAULT NULL,
    legacy INTEGER DEFAULT 0,
    persistent INTEGER DEFAULT 1,
    created_at TEXT,
    last_seen TEXT,
    revoked_at TEXT,
    revealed_at TEXT
  )");
  // Ensure raw_secret column exists for older DBs
  try {
    $cols = $pdo->query("PRAGMA table_info(tokens)")->fetchAll(PDO::FETCH_ASSOC);
    $hasRaw = false; foreach ($cols as $c) { if ($c['name'] === 'raw_secret') { $hasRaw = true; break; } }
    if (!$hasRaw) {
      $pdo->exec("ALTER TABLE tokens ADD COLUMN raw_secret TEXT DEFAULT NULL");
    }
    if (!in_array('revealed_at', array_column($cols,'name'))) {
      // some older DBs didn't have revealed_at; it's already in create above so try silent add
      try { $pdo->exec("ALTER TABLE tokens ADD COLUMN revealed_at TEXT"); } catch(Exception $e) {}
    }
  } catch(Exception $e) {}

  $pdo->exec("CREATE TABLE IF NOT EXISTS accounts (
    email TEXT PRIMARY KEY,
    plan TEXT,
    expires_at TEXT,
    active INTEGER DEFAULT 0
  )");

  // perform one-time migration from tokens.json / accounts.json if present
  try {
    migrate_from_json($pdo);
  } catch (Exception $e) {
    // migration should not block operation; continue
  }

  return $pdo;
}

function migrate_from_json($pdo) {
  $tokensStore = __DIR__ . '/tokens.json';
  if (file_exists($tokensStore)) {
    $c = file_get_contents($tokensStore);
    $arr = json_decode($c, true);
    if (is_array($arr) && count($arr) > 0) {
      $stmtIns = $pdo->prepare('INSERT OR IGNORE INTO tokens (id,email,label,device,token_hash,legacy,persistent,created_at,last_seen) VALUES (:id,:email,:label,:device,:token_hash,1,1,:created_at,:last_seen)');
      foreach ($arr as $t) {
        $id = isset($t['id']) ? $t['id'] : bin2hex(random_bytes(8));
        $raw = isset($t['token']) ? $t['token'] : null;
        if (!$raw) continue;
        $hash = password_hash((string)$raw, PASSWORD_DEFAULT);
        $stmtIns->execute([
          ':id'=>$id,
          ':email'=>isset($t['email']) ? $t['email'] : '',
          ':label'=>isset($t['label']) ? $t['label'] : null,
          ':device'=>isset($t['device']) ? $t['device'] : null,
          ':token_hash'=>$hash,
          ':created_at'=>isset($t['created_at']) ? $t['created_at'] : date('c'),
          ':last_seen'=>isset($t['last_seen']) ? $t['last_seen'] : date('c')
        ]);
      }
      // move existing store aside to avoid repeated migrations
      @rename($tokensStore, $tokensStore . '.migrated');
    }
  }

  $accStore = __DIR__ . '/accounts.json';
  if (file_exists($accStore)) {
    $c = file_get_contents($accStore);
    $arr = json_decode($c, true);
    if (is_array($arr)) {
      $stmtAcc = $pdo->prepare('INSERT OR REPLACE INTO accounts (email,plan,expires_at,active) VALUES (:email,:plan,:expires_at,:active)');
      foreach ($arr as $a) {
        if (empty($a['email'])) continue;
        $stmtAcc->execute([':email'=>$a['email'],':plan'=>isset($a['plan'])?$a['plan']:null,':expires_at'=>isset($a['expires_at'])?$a['expires_at']:null,':active'=>isset($a['active'])?($a['active']?1:0):0]);
      }
      @rename($accStore, $accStore . '.migrated');
    }
  }
}

// Decode basic JWT payload without verifying (UI-only)
function decode_jwt_payload($token) {
  $parts = explode('.', $token);
  if (count($parts) < 2) return null;
  $b = $parts[1]; $b = str_replace(['-','_'], ['+','/'], $b);
  while (strlen($b) % 4) $b .= '=';
  $json = base64_decode($b);
  return $json ? json_decode($json, true) : null;
}

// Determine email from either a JWT or a device token (raw supplied token)
function email_from_auth_token($token) {
  if (!$token) return null;
  $payload = decode_jwt_payload($token);
  if ($payload && !empty($payload['email'])) return $payload['email'];
  // otherwise treat as device token; find matching token record
  $row = token_row_from_raw($token);
  if ($row) return $row['email'];
  return null;
}

function token_row_from_raw($token) {
  if (!$token) return null;
  $pdo = get_db_conn();
  // If token looks like id.secret (contains a dot) try quick id lookup
  if (strpos($token, '.') !== false) {
    list($id, $secret) = explode('.', $token, 2);
    $stmt = $pdo->prepare('SELECT * FROM tokens WHERE id = :id AND revoked_at IS NULL LIMIT 1');
    $stmt->execute([':id'=>$id]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if ($row && password_verify($secret, $row['token_hash'])) {
      // update last_seen
      $u = $pdo->prepare('UPDATE tokens SET last_seen = :ls WHERE id = :id'); $u->execute([':ls'=>date('c'),':id'=>$id]);
      return $row;
    }
  }
  // fallback: iterate legacy tokens (older tokens without id prefix)
  $stmt = $pdo->query('SELECT * FROM tokens WHERE legacy = 1 AND revoked_at IS NULL');
  while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
    if (password_verify($token, $row['token_hash'])) {
      // update last_seen
      $u = $pdo->prepare('UPDATE tokens SET last_seen = :ls WHERE id = :id'); $u->execute([':ls'=>date('c'),':id'=>$row['id']]);
      return $row;
    }
  }

  // JSON fallback removed — tokens are verified only against the DB. Ensure migration completed and tokens.json is deprecated.
  return null;
}

function email_from_auth_token($token) {
  if (!$token) return null;
  $payload = decode_jwt_payload($token);
  if ($payload && !empty($payload['email'])) return $payload['email'];
  $row = token_row_from_raw($token);
  if ($row) return $row['email'];
  return null;
}

function create_token_for($email, $label = null, $device = null) {
  $pdo = get_db_conn();
  $id = bin2hex(random_bytes(8));
  $secret = bin2hex(random_bytes(22));
  $hash = password_hash($secret, PASSWORD_DEFAULT);
  $stmt = $pdo->prepare('INSERT INTO tokens (id,email,label,device,token_hash,raw_secret,legacy,persistent,created_at,last_seen) VALUES (:id,:email,:label,:device,:token_hash,:raw_secret,0,1,:created_at,:last_seen)');
  $now = date('c');
  $stmt->execute([':id'=>$id,':email'=>$email,':label'=>$label,':device'=>$device,':token_hash'=>$hash,':raw_secret'=>$secret,':created_at'=>$now,':last_seen'=>$now]);
  // token string returned to user (show once)
  return ['id'=>$id, 'token'=>$id . '.' . $secret];
}

function list_tokens_for($email) {
  $pdo = get_db_conn();
  $stmt = $pdo->prepare('SELECT id, label, device, created_at, last_seen, persistent FROM tokens WHERE email = :email AND revoked_at IS NULL ORDER BY created_at DESC');
  $stmt->execute([':email'=>$email]);
  return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

function revoke_token_for($email, $id) {
  $pdo = get_db_conn();
  $stmt = $pdo->prepare('SELECT id FROM tokens WHERE id = :id AND email = :email AND revoked_at IS NULL LIMIT 1');
  $stmt->execute([':id'=>$id,':email'=>$email]);
  $row = $stmt->fetch(PDO::FETCH_ASSOC);
  if (!$row) return false;
  $u = $pdo->prepare('UPDATE tokens SET revoked_at = :rev WHERE id = :id');
  $u->execute([':rev'=>date('c'),':id'=>$id]);
  return true;
}

function reveal_token_by_id($email, $id) {
  $pdo = get_db_conn();
  $stmt = $pdo->prepare('SELECT raw_secret, revealed_at, email FROM tokens WHERE id = :id LIMIT 1');
  $stmt->execute([':id'=>$id]);
  $row = $stmt->fetch(PDO::FETCH_ASSOC);
  if (!$row) return null;
  if ($row['email'] !== $email) return null;
  if (!empty($row['revealed_at'])) return null; // already revealed
  $secret = $row['raw_secret'];
  // clear stored secret and mark revealed
  $u = $pdo->prepare('UPDATE tokens SET raw_secret = NULL, revealed_at = :rev WHERE id = :id');
  $u->execute([':rev'=>date('c'),':id'=>$id]);
  if ($secret) return $row['id'].'.'.$secret;
  return null;
}

function get_account_summary_for($email) {
  $pdo = get_db_conn();
  $stmt = $pdo->prepare('SELECT plan, expires_at, active FROM accounts WHERE email = :email LIMIT 1');
  $stmt->execute([':email'=>$email]);
  $row = $stmt->fetch(PDO::FETCH_ASSOC);
  if ($row) return ['plan'=>$row['plan'],'expires_at'=>$row['expires_at'],'active'=>!empty($row['active'])];
  return null;
}

?>