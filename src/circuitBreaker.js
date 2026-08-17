/**
 * Circuit breaker — timeout/error ติดกันหลายครั้งแล้วพักยิง ERP
 */

function createCircuitBreaker({
  failureThreshold = 3,
  cooldownMs = 60 * 1000,
} = {}) {
  let failures = 0;
  let openUntil = 0;

  function assertCanRequest() {
    const now = Date.now();
    if (now < openUntil) {
      const retryAfterMs = openUntil - now;
      const err = new Error(
        `ERP ไม่พร้อมชั่วคราว — ลองใหม่ในประมาณ ${Math.ceil(
          retryAfterMs / 1000
        )} วินาที`
      );
      err.statusCode = 503;
      err.code = "CIRCUIT_OPEN";
      err.retryAfterMs = retryAfterMs;
      throw err;
    }
  }

  function recordSuccess() {
    failures = 0;
    openUntil = 0;
  }

  function recordFailure() {
    failures += 1;
    if (failures >= failureThreshold) {
      openUntil = Date.now() + cooldownMs;
      failures = 0;
    }
  }

  function getStatus() {
    const now = Date.now();
    if (now < openUntil) {
      return {
        state: "open",
        openUntil,
        retryAfterMs: openUntil - now,
        failures,
        failureThreshold,
        cooldownMs,
      };
    }
    return {
      state: "closed",
      openUntil: 0,
      retryAfterMs: 0,
      failures,
      failureThreshold,
      cooldownMs,
    };
  }

  return { assertCanRequest, recordSuccess, recordFailure, getStatus };
}

module.exports = { createCircuitBreaker };
