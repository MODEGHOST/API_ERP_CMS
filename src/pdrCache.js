/**
 * In-memory cache ตามเลข PDR — TTL สั้นๆ กันยิง MSSQL ซ้ำก่อนบันทึก CMS
 */

function createPdrCache({ ttlMs = 10 * 60 * 1000, maxEntries = 500 } = {}) {
  const map = new Map();

  function normalizeKey(pdrNo) {
    return String(pdrNo || "")
      .trim()
      .toUpperCase();
  }

  function pruneExpired(now = Date.now()) {
    for (const [key, entry] of map) {
      if (entry.expiresAt <= now) map.delete(key);
    }
  }

  function get(pdrNo) {
    const key = normalizeKey(pdrNo);
    if (!key) return null;
    const entry = map.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      map.delete(key);
      return null;
    }
    // touch order สำหรับ eviction แบบ FIFO ของ Map
    map.delete(key);
    map.set(key, entry);
    return entry.value;
  }

  function set(pdrNo, value) {
    const key = normalizeKey(pdrNo);
    if (!key) return;
    pruneExpired();
    while (map.size >= maxEntries && !map.has(key)) {
      const oldest = map.keys().next().value;
      map.delete(oldest);
    }
    map.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  function stats() {
    pruneExpired();
    return { size: map.size, ttlMs, maxEntries };
  }

  return { get, set, stats };
}

module.exports = { createPdrCache };
