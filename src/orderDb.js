/**
 * ดึงเลข PDR / PDW ตามวันตีบิล — ทีละเดือนเท่านั้น
 * ใบซ้ำนับ 1, อันอื่นใน [Prod_ Order No_] ไม่เอา
 *
 * CMS เอา data[] ไป upsert ลง order_daily_count
 */

const fs = require("fs");
const path = require("path");

const MOCK_PATH = path.join(__dirname, "mock-orders.json");
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDate(value) {
  const m = DATE_RE.exec(String(value || "").trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const lastDay = new Date(year, month, 0).getDate();
  if (month < 1 || month > 12 || day < 1 || day > lastDay) return null;
  return { year, month, day, iso: `${m[1]}-${m[2]}-${m[3]}` };
}

function validateMonthRange(fromRaw, toRaw) {
  const from = parseDate(fromRaw);
  const to = parseDate(toRaw);

  if (!from || !to) {
    return {
      error: "ต้องระบุ from และ to เป็น YYYY-MM-DD เช่น /api/orders?from=2026-01-01&to=2026-01-31",
    };
  }
  if (from.iso > to.iso) {
    return { error: "from ต้องไม่เกิน to" };
  }
  if (from.year !== to.year || from.month !== to.month) {
    return {
      error: "ดึงได้ทีละเดือน เช่น from=2026-01-01&to=2026-01-31",
    };
  }

  return { from: from.iso, to: to.iso };
}

function toIsoDate(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    const m = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getUTCFullYear();
    const mo = String(value.getUTCMonth() + 1).padStart(2, "0");
    const d = String(value.getUTCDate()).padStart(2, "0");
    return `${y}-${mo}-${d}`;
  }
  return null;
}

function orderTypeOf(orderNo) {
  const prefix = String(orderNo || "").trim().toUpperCase().slice(0, 3);
  if (prefix === "PDR" || prefix === "PDW") return prefix;
  return null;
}

function uniqOrders(rows) {
  const byNo = new Map();

  for (const row of rows) {
    const orderNo = String(row.order_no || "").trim();
    const orderType = row.order_type || orderTypeOf(orderNo);
    const shipmentDate = toIsoDate(row.shipment_date);
    if (!orderNo || !orderType || !shipmentDate) continue;
    if (orderType !== "PDR" && orderType !== "PDW") continue;

    const prev = byNo.get(orderNo);
    if (!prev || shipmentDate > prev.shipment_date) {
      byNo.set(orderNo, {
        order_no: orderNo,
        order_type: orderType,
        shipment_date: shipmentDate,
      });
    }
  }

  return Array.from(byNo.values()).sort((a, b) => {
    if (a.shipment_date !== b.shipment_date) {
      return a.shipment_date.localeCompare(b.shipment_date);
    }
    return a.order_no.localeCompare(b.order_no);
  });
}

function summarize(data) {
  return {
    total: data.length,
    total_pdr: data.filter((r) => r.order_type === "PDR").length,
    total_pdw: data.filter((r) => r.order_type === "PDW").length,
    data,
  };
}

function buildOrderSql() {
  return `
    SELECT
      pp.[Prod_ Order No_] AS order_no,
      CASE
        WHEN UPPER(pp.[Prod_ Order No_]) LIKE N'PDR%' THEN N'PDR'
        WHEN UPPER(pp.[Prod_ Order No_]) LIKE N'PDW%' THEN N'PDW'
      END AS order_type,
      CAST(MAX(pp.[Shipment Date]) AS date) AS shipment_date
    FROM [LFB Golive$Production Planning] pp
    WHERE pp.[Shipment Date] >= @from
      AND pp.[Shipment Date] < DATEADD(day, 1, @to)
      AND (
        UPPER(pp.[Prod_ Order No_]) LIKE N'PDR%'
        OR UPPER(pp.[Prod_ Order No_]) LIKE N'PDW%'
      )
    GROUP BY pp.[Prod_ Order No_]
    ORDER BY shipment_date, order_no
  `;
}

function queryMock(from, to) {
  const all = JSON.parse(fs.readFileSync(MOCK_PATH, "utf8"));
  const rows = all.filter((row) => {
    const day = toIsoDate(row.shipment_date);
    return day && day >= from && day <= to;
  });
  return summarize(uniqOrders(rows));
}

async function queryErp(config, from, to) {
  const driver = (config.driver || "mssql").toLowerCase();
  if (driver !== "mssql") {
    throw new Error("GET /api/orders ใช้ได้เฉพาะ driver mssql");
  }

  const sql = require("mssql");
  const pool = await sql.connect({
    server: config.host,
    port: config.port_db || 1433,
    database: config.database,
    user: config.user,
    password: config.password,
    options: {
      encrypt: !!(config.options && config.options.encrypt),
      trustServerCertificate: !!(
        config.options && config.options.trustServerCertificate
      ),
    },
  });

  try {
    const req = pool.request();
    req.input("from", sql.Date, from);
    req.input("to", sql.Date, to);
    const result = await req.query(buildOrderSql());
    return summarize(uniqOrders(result.recordset || []));
  } finally {
    await pool.close();
  }
}

async function getOrderList({ mode, config, from, to }) {
  const range = validateMonthRange(from, to);
  if (range.error) {
    const err = new Error(range.error);
    err.statusCode = 400;
    throw err;
  }

  const result =
    mode === "erp"
      ? await queryErp(config, range.from, range.to)
      : queryMock(range.from, range.to);

  return {
    from: range.from,
    to: range.to,
    ...result,
  };
}

module.exports = { getOrderList, validateMonthRange };
