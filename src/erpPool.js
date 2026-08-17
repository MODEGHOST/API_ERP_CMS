/**
 * Persistent MSSQL pool — เปิดครั้งเดียวต่อ process ใช้ซ้ำทุก request
 * ไม่ connect/close ทุกครั้งที่ค้น PDR
 */

let poolPromise = null;
let lastConfigKey = null;

function buildPoolConfig(config) {
  const poolCfg = config.pool || {};
  return {
    server: config.host,
    port: config.port_db || 1433,
    database: config.database,
    user: config.user,
    password: config.password,
    connectionTimeout: Number(poolCfg.connection_timeout_ms || 15000),
    // 120s รองรับทั้งค้น PDR และ /api/orders ทีละเดือน
    requestTimeout: Number(poolCfg.request_timeout_ms || 120000),
    pool: {
      max: Number(poolCfg.max || 5),
      min: Number(poolCfg.min || 0),
      idleTimeoutMillis: Number(poolCfg.idle_timeout_ms || 30000),
    },
    options: {
      encrypt: !!(config.options && config.options.encrypt),
      trustServerCertificate: !!(
        config.options && config.options.trustServerCertificate
      ),
    },
  };
}

function configKey(config) {
  return [
    config.host,
    config.port_db || 1433,
    config.database,
    config.user,
  ].join("|");
}

/**
 * คืน ConnectionPool ที่ connect แล้ว — lazy ครั้งแรก
 */
async function getErpPool(config) {
  const key = configKey(config);
  if (poolPromise && lastConfigKey !== key) {
    await closeErpPool().catch(() => {});
  }

  if (!poolPromise) {
    lastConfigKey = key;
    const sql = require("mssql");
    const pool = new sql.ConnectionPool(buildPoolConfig(config));
    poolPromise = pool.connect().catch((err) => {
      poolPromise = null;
      lastConfigKey = null;
      throw err;
    });
  }

  return poolPromise;
}

async function closeErpPool() {
  if (!poolPromise) return;
  const pending = poolPromise;
  poolPromise = null;
  lastConfigKey = null;
  try {
    const pool = await pending;
    if (pool && typeof pool.close === "function") {
      await pool.close();
    }
  } catch {
    // ignore — pool อาจยัง connect ไม่สำเร็จ
  }
}

function getErpPoolStatus() {
  return {
    ready: Boolean(poolPromise),
  };
}

module.exports = {
  getErpPool,
  closeErpPool,
  getErpPoolStatus,
};
