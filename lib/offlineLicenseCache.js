const crypto = require('crypto');

function tokenFingerprint(token) {
  if (typeof token !== 'string' || !token) return null;
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function toExpiryMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 100000000000 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return toExpiryMs(Number(trimmed));
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function createOfflineLicenseCache(token, status, now = Date.now()) {
  const expiresAtMs = toExpiryMs(status && status.expires_at);
  if (!tokenFingerprint(token) || !status || !status.active || !expiresAtMs || expiresAtMs <= now) return null;
  return {
    version: 1,
    tokenFingerprint: tokenFingerprint(token),
    savedAt: now,
    expiresAtMs,
    status: {
      active: true,
      plan: status.plan || null,
      expires_at: status.expires_at,
      email: status.email || null,
      founder: !!status.founder
    }
  };
}

function restoreOfflineLicenseCache(cache, token, now = Date.now()) {
  if (!cache || cache.version !== 1 || cache.tokenFingerprint !== tokenFingerprint(token)) return null;
  if (!cache.status || !cache.status.active || !Number.isFinite(cache.expiresAtMs) || cache.expiresAtMs <= now) return null;
  return {
    ...cache.status,
    active: true,
    source: 'offline-cache',
    offline: true,
    cachedAt: cache.savedAt,
    offlineUntil: cache.expiresAtMs
  };
}

module.exports = { tokenFingerprint, toExpiryMs, createOfflineLicenseCache, restoreOfflineLicenseCache };
