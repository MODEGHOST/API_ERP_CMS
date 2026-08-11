/**
 * เทสต์แค่ต่อ MSSQL ได้ไหม — ไม่ดึงข้อมูลเยอะ
 * รัน: node test-db.js
 */
const fs = require("fs");
const path = require("path");

async function main() {
  const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, "config.json"), "utf8")
  );

  console.log("Connecting...", {
    host: config.host,
    database: config.database,
    user: config.user,
    driver: config.driver,
  });

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
      connectTimeout: 10000,
    },
  });

  try {
    const ping = await pool.request().query("SELECT 1 AS ok");
    console.log("OK: connected", ping.recordset[0]);

    const sample = await pool.request().query(`
      SELECT TOP 1
        pp.[Prod_ Order No_] AS pdr_no,
        pp.[Sales Order No_] AS sale_order_no,
        pp.[Customer Name] AS company_name,
        sl.[Unit Price] AS price_per_sheet,
        i.[Grade Code] AS grade
      FROM [LFB Golive$Production Planning] pp
      LEFT JOIN [LFB Golive$Item] i ON i.[No_] = pp.[Item No_]
      OUTER APPLY (
        SELECT TOP 1 s.[Unit Price]
        FROM [LFB Golive$Sales Line] s
        WHERE s.[Prod_ Order No_] = pp.[Prod_ Order No_]
        ORDER BY s.[Line No_]
      ) sl
    `);

    console.log("OK: sample row");
    console.log(sample.recordset[0] || "(no rows)");
  } finally {
    await pool.close();
  }
}

main().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
