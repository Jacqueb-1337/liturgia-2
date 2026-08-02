const { createOfflineLicenseCache, restoreOfflineLicenseCache, toExpiryMs } = require('../lib/offlineLicenseCache');

describe('offline license cache', () => {
  const now = 1800000000000;
  const token = 'device-token-for-test';
  const status = { active: true, plan: 'yearly', expires_at: 1800003600, email: 'church@example.test', founder: true };

  test('restores a server-verified active subscription for the same token', () => {
    const cache = createOfflineLicenseCache(token, status, now);
    expect(restoreOfflineLicenseCache(cache, token, now)).toMatchObject({
      active: true,
      plan: 'yearly',
      source: 'offline-cache',
      offline: true,
      founder: true
    });
  });

  test('rejects changed tokens, expired entries, and inactive server statuses', () => {
    const cache = createOfflineLicenseCache(token, status, now);
    expect(restoreOfflineLicenseCache(cache, 'different-token', now)).toBeNull();
    expect(restoreOfflineLicenseCache(cache, token, 1800003600000)).toBeNull();
    expect(createOfflineLicenseCache(token, { ...status, active: false }, now)).toBeNull();
  });

  test('normalizes Unix-second and ISO expiration values', () => {
    expect(toExpiryMs(1800003600)).toBe(1800003600000);
    expect(toExpiryMs('2027-01-15T00:00:00.000Z')).toBe(Date.parse('2027-01-15T00:00:00.000Z'));
  });
});
