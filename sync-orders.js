/**
 * ดึง PDR/PDW จาก ERP แล้ว upsert ลง CMS.order_daily_count
 * — อ่าน ERP อย่างเดียว ไม่เขียน ERP
 *
 * รายวัน (ค่าเริ่มต้น): ย้อน 3 วันถึงเมื่อวาน
 *   node sync-orders.js
 *   node sync-orders.js --daily
 *
 * ของเก่าทั้งปี:
 *   node sync-orders.js --backfill
 */
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const { getOrderList } = require("./src/orderDb");

const PAUSE_MS = 20 * 1000;
const DAILY_DAYS = 3;
const START_YEAR = 2026;
const START_MONTH = 1;

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

function monthRangesBackfill() {
  const yest = yesterdayIso();
  const end = new Date(`${yest}T00:00:00`);
  const ranges = [];

  for (
    let year = START_YEAR, month = START_MONTH;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tableName(raw) {
  const name = String(raw || "order_daily_count").replace(/[^a-zA-Z0-9_]/g, "");
  if (!name) throw new Error("cms.table ไม่ถูกต้อง");
  return name;
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
    if (row.order_type !== "PDR" && row.order_type !== "PDW") continue;
    await conn.execute(sql, [row.order_no, row.order_type, row.shipment_date]);
    count += 1;
  }
  return count;
}

async function main() {
  const backfill = process.argv.includes("--backfill");
  const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, "config.json"), "utf8")
  );
  const cms = config.cms;
  if (!cms || !cms.host || !cms.database || !cms.user) {
    throw new Error("ใส่ cms.host / database / user ใน config.json ก่อน");
  }

  const mode =
    String(config.mode || "mock").toLowerCase() === "erp" ? "erp" : "mock";
  const ranges = backfill ? monthRangesBackfill() : monthRangesDaily();
  const table = tableName(cms.table);
  const label = backfill
    ? `backfill ทีละเดือน ถึงเมื่อวาน ${yesterdayIso()}`
    : `รายวัน ย้อน ${DAILY_DAYS} วันถึงเมื่อวาน ${yesterdayIso()}`;

  console.log(`mode=${mode} ${label}`);
  console.log(`จะดึง ${ranges.length} ช่วง พัก ${PAUSE_MS / 1000} วินาทีถ้ามีมากกว่า 1 ช่วง`);

  const conn = await mysql.createConnection({
    host: cms.host,
    port: cms.port || 3306,
    database: cms.database,
    user: cms.user,
    password: cms.password || "",
  });

  try {
    for (let i = 0; i < ranges.length; i += 1) {
      const { from, to } = ranges[i];
      console.log(`[${i + 1}/${ranges.length}] ERP SELECT ${from} .. ${to}`);

      const result = await getOrderList({ mode, config, from, to });
      const inserted = await upsertOrders(conn, table, result.data);

      console.log(
        `  ได้ PDR=${result.total_pdr} PDW=${result.total_pdw} บันทึก=${inserted}`
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
