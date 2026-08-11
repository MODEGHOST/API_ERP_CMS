/**
 * Smoke: ERP + customer_care enrich (read-only)
 * node test-enrich.js
 */
const fs = require("fs");
const path = require("path");
const { getPdrList } = require("./src/pdrDb");

async function main() {
  const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, "config.json"), "utf8")
  );

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

  let pdrNo;
  let companyName;
  try {
    const liked = await pool.request().query(`
      SELECT TOP 1
        pp.[Prod_ Order No_] AS pdr_no,
        pp.[Customer Name] AS company_name
      FROM [LFB Golive$Production Planning] pp
      WHERE pp.[Customer Name] LIKE N'%กรีนคาร์ตอน%'
    `);
    if (liked.recordset[0]) {
      pdrNo = liked.recordset[0].pdr_no;
      companyName = liked.recordset[0].company_name;
    } else {
      const any = await pool.request().query(`
        SELECT TOP 1
          pp.[Prod_ Order No_] AS pdr_no,
          pp.[Customer Name] AS company_name
        FROM [LFB Golive$Production Planning] pp
        WHERE pp.[Customer Name] IS NOT NULL AND pp.[Customer Name] <> N''
      `);
      pdrNo = any.recordset[0]?.pdr_no;
      companyName = any.recordset[0]?.company_name;
    }
  } finally {
    await pool.close();
  }

  if (!pdrNo) {
    console.log("No PDR sample found");
    return;
  }

  console.log("ERP sample:", { pdrNo, companyName });
  const out = await getPdrList({ mode: "erp", config, pdrNo });
  const row = out.data[0] || {};
  console.log("API row:", {
    pdr_no: row.pdr_no,
    company_name: row.company_name,
    grade: row.grade,
    sale_nickname: row.sale_nickname,
    cs_name: row.cs_name,
    sale_cs_staff: row.sale_cs_staff,
    customer_care_matched: row.customer_care_matched || null,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
