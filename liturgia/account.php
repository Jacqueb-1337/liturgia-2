<?php
// Moved from index.php to account.php to keep the account management interface accessible.
?>
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Liturgia Account</title>
<link rel="stylesheet" href="/liturgia/style.css">
</head>
<body class="dark">
  <div class="container">
    <h1>Liturgia Account</h1>
    <p>Sign in to manage your subscription and download the client.</p>

    <section>
      <h3>Send magic link</h3>
      <input id="email" placeholder="you@example.com" />
      <button id="send">Send Magic Link</button>
    </section>

    <section style="margin-top:20px">
      <h3>Have a token?</h3>
      <input id="token" placeholder="Paste token here" style="width:60%" />
      <button id="use">Use Token</button>
    </section>

    <section id="account" style="margin-top:20px;display:none">
      <h3>Account</h3>
      <div id="acct-info"></div>
      <div style="margin-top:10px">
        <button id="manage">Manage Subscription</button>
        <button id="download">Download Client</button>
      </div>
    </section>

    <div id="status"></div>
  </div>

<script>
const serverBase = './'; // relative in this simple installer
document.getElementById('send').onclick = async () => {
  const email = document.getElementById('email').value.trim();
  if (!email) return alert('Enter email');
  document.getElementById('status').textContent = 'Sending magic link...';
  try {
    const res = await fetch(serverBase + 'auth/magic-link.php', { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body: `email=${encodeURIComponent(email)}`});
    const j = await res.json();
    if (j.ok) document.getElementById('status').textContent = 'Magic link sent — check your email (and spam/junk folder).';
    else document.getElementById('status').textContent = 'Failed to send: ' + (j.error||'');
  } catch (e) { document.getElementById('status').textContent = 'Error sending magic link'; }
};

document.getElementById('use').onclick = async () => {
  const token = document.getElementById('token').value.trim();
  if (!token) return alert('Paste token from verify page');
  document.getElementById('status').textContent = 'Checking token...';
  try {
    const res = await fetch(serverBase + 'license-status.php', { headers: { 'Authorization': 'Bearer ' + token } });
    if (res.status === 200) {
      const j = await res.json();
      document.getElementById('acct-info').innerHTML = `<p>Active: ${j.active}</p><p>Plan: ${j.plan||'n/a'}</p><p>Expires: ${j.expires_at ? new Date(j.expires_at*1000).toLocaleString() : 'n/a'}</p>`;
      document.getElementById('account').style.display = '';
      document.getElementById('status').textContent = 'Verified.';
      // attach actions
      document.getElementById('manage').onclick = async () => {
        document.getElementById('status').textContent = 'Opening Customer Portal...';
        const r = await fetch(serverBase + 'create-portal-session.php', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token } });
        const j2 = await r.json();
        if (j2.url) window.open(j2.url, '_blank');
        else alert('Failed to open portal');
      };
      document.getElementById('download').onclick = () => alert('Download not yet available.');
    } else {
      const t = await res.text();
      document.getElementById('status').textContent = 'Token invalid or expired.';
      alert('Token invalid or expired. Use the magic link to get a new one.');
    }
  } catch (e) { document.getElementById('status').textContent = 'Error verifying token'; }
};
</script>
</body>
</html>
