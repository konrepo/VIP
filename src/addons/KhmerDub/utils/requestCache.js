const CACHE = new Map();

const DEFAULT_TTL = 5 * 60 * 1000; // 5 minutes

function now() {
  return Date.now();
}

async function withRequestCache(key, fn, ttl = DEFAULT_TTL) {
  const cached = CACHE.get(key);

  if (cached && (now() - cached.ts) < ttl) {
    return cached.value;
  }

  const value = await fn();

  CACHE.set(key, {
    value,
    ts: now()
  });

  return value;
}

module.exports = {
  withRequestCache
};