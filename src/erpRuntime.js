/**
 * Shared runtime: PDR cache + circuit breaker (ต่อ process)
 */

const { createPdrCache } = require("./pdrCache");
const { createCircuitBreaker } = require("./circuitBreaker");

let cache = null;
let breaker = null;
let inited = false;

function initErpRuntime(config = {}) {
  if (inited) return { cache, breaker };

  const cacheCfg = config.pdr_cache || {};
  const breakerCfg = config.circuit_breaker || {};

  const ttlSeconds = Number(cacheCfg.ttl_seconds ?? 600);
  const maxEntries = Number(cacheCfg.max_entries ?? 500);
  const failureThreshold = Number(breakerCfg.failure_threshold ?? 3);
  const cooldownSeconds = Number(breakerCfg.cooldown_seconds ?? 60);

  cache = createPdrCache({
    ttlMs: Math.max(30, ttlSeconds) * 1000,
    maxEntries: Math.max(10, maxEntries),
  });
  breaker = createCircuitBreaker({
    failureThreshold: Math.max(1, failureThreshold),
    cooldownMs: Math.max(5, cooldownSeconds) * 1000,
  });
  inited = true;

  return { cache, breaker };
}

function getErpRuntime() {
  if (!inited) {
    return initErpRuntime({});
  }
  return { cache, breaker };
}

module.exports = { initErpRuntime, getErpRuntime };
