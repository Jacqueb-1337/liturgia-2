function safeStatus(msg) {
  const el = document.getElementById('status');
  if (el) el.textContent = msg;
}

module.exports = { safeStatus };