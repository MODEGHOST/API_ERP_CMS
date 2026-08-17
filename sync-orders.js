/**
 * ดึง Prod Order (PDC..PDZ ตาม ORDER_TYPES) จาก ERP แล้ว upsert ลง CMS.order_daily_count
 * — อ่าน ERP อย่างเดียว (SELECT) ไม่เขียน ERP
 *
 * รายวัน (ค่าเริ่มต้น): ย้อน 3 วันถึงเมื่อวาน
 *   node sync-orders.js
 *   node sync-orders.js --daily
 *
 * ของเก่าทั้งปี (ทีละเดือน + พักนานๆ):
 *   node sync-orders.js --backfill
 *   node sync-orders.js --backfill --from=2026-07
 */
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const { getOrderList, ORDER_TYPES } = require("./src/orderDb");

/** พักระหว่างเดือน — ช้าได้ เพื่อลดภาระ ERP */
const PAUSE_MS = 60 * 1000;
const RETRY_MAX = 3;
const RETRY_PAUSE_MS = 90 * 1000;
const DAILY_DAYS = 3;
const START_YEAR = 2026;
const START_MONTH = 1;
const ORDER_TYPE_SET = new Set(ORDER_TYPES);
const ENUM_SQL = ORDER_TYPES.map((t) => `'${t}'`).join(", ");

function pad(n) {
  return String(n).padStart(2, "0");
}

function toIso(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDaysIso(iso, days) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return toIso(d);
}

function yesterdayIso() {
  return addDaysIso(toIso(new Date()), -1);
}

function splitByMonth(fromIso, toIso) {
  const ranges = [];
  let cursor = fromIso;
  while (cursor <= toIso) {
    const [year, month] = cursor.split("-").map(Number);
    const lastDay = new Date(year, month, 0).getDate();
    let monthEnd = `${year}-${pad(month)}-${pad(lastDay)}`;
    if (monthEnd > toIso) monthEnd = toIso;
    ranges.push({ from: cursor, to: monthEnd });
    cursor = addDaysIso(monthEnd, 1);
  }
  return ranges;
}

function monthRangesDaily() {
  const to = yesterdayIso();
  const from = addDaysIso(to, -(DAILY_DAYS - 1));
  return splitByMonth(from, to);
}

function parseFromArg(argv) {
  const raw = argv.find((a) => a.startsWith("--from="));
  if (!raw) return null;
  const m = /^--from=(\d{4})-(\d{2})$/.exec(raw);
  if (!m) throw new Error("ใช้ --from=YYYY-MM เช่น --from=2026-07");
  return { year: Number(m[1]), month: Number(m[2]) };
}

function monthRangesBackfill(startOverride) {
  const yest = yesterdayIso();
  const end = new Date(`${yest}T00:00:00`);
  const ranges = [];
  let year = startOverride?.year || START_YEAR;
  let month = startOverride?.month || START_MONTH;

  for (
    ;
    year < end.getFullYear() ||
    (year === end.getFullYear() && month <= end.getMonth() + 1);
    month += 1
  ) {
    if (month > 12) {
      month = 1;
      year += 1;
    }
    const lastDay = new Date(year, month, 0).getDate();
    const from = `${year}-${pad(month)}-01`;
    let to = `${year}-${pad(month)}-${pad(lastDay)}`;
    if (to > yest) to = yest;
    if (from <= to) ranges.push({ from, to });
  }

  return ranges;
}

async function fetchMonthWithRetry({ mode, config, from, to }) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRY_MAX; attempt += 1) {
    try {
      return await getOrderList({ mode, config, from, to });
    } catch (err) {
      lastErr = err;
      console.error(
        `  ล้มเหลวครั้งที่ ${attempt}/${RETRY_MAX}: ${err.message || err}`
      );
      if (attempt < RETRY_MAX) {
        console.log(`  พัก ${RETRY_PAUSE_MS / 1000} วินาทีแล้วลองใหม่...`);
        await sleep(RETRY_PAUSE_MS);
      }
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tableName(raw) {
  const name = String(raw || "order_daily_count").replace(/[^a-zA-Z0-9_]/g, "");
  if (!name) throw new Error("cms.table ไม่ถูกต้อง");
  return name;
}

async function ensureOrderTable(conn, table) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS \`${table}\` (
      order_no VARCHAR(80) NOT NULL,
      order_type ENUM(${ENUM_SQL}) NOT NULL,
      shipment_date DATE NOT NULL,
      synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (order_no),
      KEY idx_order_daily_shipment (shipment_date),
      KEY idx_order_daily_type_date (order_type, shipment_date)
    ) ENGINE=InnoDB
  `);
  // ตารางเก่าอาจยังเป็น ENUM('PDR','PDW') — ขยายก่อน upsert
  await conn.query(`
    ALTER TABLE \`${table}\`
      MODIFY COLUMN order_type ENUM(${ENUM_SQL}) NOT NULL
  `);
}

async function upsertOrders(conn, table, rows) {
  if (!rows.length) return 0;

  const sql = `
    INSERT INTO \`${table}\` (order_no, order_type, shipment_date, synced_at)
    VALUES (?, ?, ?, NOW())
    ON DUPLICATE KEY UPDATE
      order_type = VALUES(order_type),
      shipment_date = VALUES(shipment_date),
      synced_at = NOW()
  `;

  let count = 0;
  for (const row of rows) {
    if (!ORDER_TYPE_SET.has(row.order_type)) continue;
    await conn.execute(sql, [row.order_no, row.order_type, row.shipment_date]);
    count += 1;
  }
  return count;
}

function formatByType(byType) {
  if (!byType) return "";
  return ORDER_TYPES.filter((t) => byType[t] > 0)
    .map((t) => `${t}=${byType[t]}`)
    .join(" ");
}

async function main() {
  const backfill = process.argv.includes("--backfill");
  const fromOverride = parseFromArg(process.argv);
  const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, "config.json"), "utf8")
  );
  const cms = config.cms;
  if (!cms || !cms.host || !cms.database || !cms.user) {
    throw new Error("ใส่ cms.host / database / user ใน config.json ก่อน");
  }

  const mode =
    String(config.mode || "mock").toLowerCase() === "erp" ? "erp" : "mock";
  const ranges = backfill
    ? monthRangesBackfill(fromOverride)
    : monthRangesDaily();
  const table = tableName(cms.table);
  const label = backfill
    ? `backfill ทีละเดือน ถึงเมื่อวาน ${yesterdayIso()}${fromOverride ? ` เริ่ม ${fromOverride.year}-${pad(fromOverride.month)}` : ""}`
    : `รายวัน ย้อน ${DAILY_DAYS} วันถึงเมื่อวาน ${yesterdayIso()}`;

  console.log(`mode=${mode} ${label}`);
  console.log(`ประเภท: ${ORDER_TYPES.join(", ")}`);
  console.log(
    `จะดึง ${ranges.length} ช่วง · พัก ${PAUSE_MS / 1000}s ระหว่างเดือน · retry ${RETRY_MAX} ครั้ง (พัก ${RETRY_PAUSE_MS / 1000}s)`
  );

  const conn = await mysql.createConnection({
    host: cms.host,
    port: cms.port || 3306,
    database: cms.database,
    user: cms.user,
    password: cms.password || "",
  });

  try {
    await ensureOrderTable(conn, table);

    for (let i = 0; i < ranges.length; i += 1) {
      const { from, to } = ranges[i];
      console.log(`[${i + 1}/${ranges.length}] ERP SELECT ${from} .. ${to}`);

      const result = await fetchMonthWithRetry({ mode, config, from, to });
      const inserted = await upsertOrders(conn, table, result.data);

      console.log(
        `  ได้ total=${result.total} (${formatByType(result.by_type) || "ว่าง"}) บันทึก=${inserted}`
      );

      if (i < ranges.length - 1) {
        console.log(`  พัก ${PAUSE_MS / 1000} วินาที...`);
        await sleep(PAUSE_MS);
      }
    }
  } finally {
    await conn.end();
  }

  console.log("เสร็จแล้ว");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
