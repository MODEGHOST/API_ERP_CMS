/**
 * ต่อ ERP + SQL + mock — พี่แก้ buildSql() ให้ตรงตารางจริง
 * config.json → mode: "erp", ใส่ host/user/password
 * ชื่อคอลัมน์ส่งมาแบบไหนก็ได้ — CMS จะแมปเองทีหลัง
 *
 * ดึงได้เฉพาะตาม pdr_no เท่านั้น (ไม่มี list ทั้งตาราง)
 *
 * MSSQL:
 *   [LFB Golive$Production Planning] pp
 *   JOIN [LFB Golive$Item] i ON i.[No_] = pp.[Item No_]
 *   OUTER APPLY [LFB Golive$Sales Line] sl ON sl.[Prod_ Order No_] = pp.[Prod_ Order No_]
 *
 * จาก Item:
 *   Grade Code → grade (อาจถูกทับด้วย customer_care ทีหลัง)
 *   Description → product_name
 *
 * จาก Sales Line (เชื่อม Prod_ Order No_):
 *   Unit Price → price_per_sheet
 *
 * จาก Production Planning (ใบ Tag ฝั่ง Reject):
 *   T → t (ผ่า)
 *   Item No_ → item_no
 *   Big Sheet → big_sheet
 *   Width (mm) หรือ S x Lenght (mm) → big_sheet_size
 *   Width (W) x Lenght (mm) → small_sheet_size
 *
 * ยังไม่มีจาก MSSQL:
 *   sale_cs_staff / grade(ลูกค้า) → เติมจาก MySQL customer_care ทีหลัง (read-only)
 *   vehicle_plate → ไม่มีใน ERP
 *   problem_name_en → กรอกเองฝั่ง CMS
 *
 * MySQL customer_care: SELECT อย่างเดียว ห้ามเขียน — ดู src/customerCare.js
 */

const fs = require("fs");
const path = require("path");
const { enrichWithCustomerCare } = require("./customerCare");

const MOCK_PATH = path.join(__dirname, "mock-data.json");

/** SQL จริงของ LFB Golive — บังคับมี pdr_no */
function buildSql({ forCount }) {
  const where = "WHERE pp.[Prod_ Order No_] = @pdr_no";

  if (forCount) {
    return `
      SELECT COUNT(*) AS total
      FROM [LFB Golive$Production Planning] pp
      LEFT JOIN [LFB Golive$Item] i ON i.[No_] = pp.[Item No_]
      ${where}
    `;
  }

  return `
    SELECT
      pp.[Prod_ Order No_] AS pdr_no,
      pp.[Sales Order No_] AS sale_order_no,
      pp.[Sequence] AS order_no,
      pp.[Customer Name] AS company_name,
      CAST(NULL AS nvarchar(100)) AS customer_alias_name,
      CAST(NULL AS nvarchar(100)) AS customer_name_en,
      pp.[Shipment Date] AS delivery_date,
      pp.[Production Date] AS production_date,
      pp.[Shipment Date] AS customer_ship_date,
      CAST(NULL AS nvarchar(200)) AS sale_cs_staff,
      pp.[Weight W] AS size,
      pp.[Work Center] AS machine_name,
      CASE
        WHEN pp.[Shift] = 0 THEN N'A'
        WHEN pp.[Shift] = 1 THEN N'B'
        ELSE CAST(pp.[Shift] AS nvarchar(10))
      END AS shift,
      CAST(NULL AS nvarchar(50)) AS vehicle_plate,
      pp.[Lonn] AS flute_name,
      pp.[M5_FG] AS paper_m5,
      pp.[M4_FG] AS paper_m4,
      pp.[M3_FG] AS paper_m3,
      pp.[M2_FG] AS paper_m2,
      pp.[M1_FG] AS paper_m1,
      pp.[Quantity] AS demand_qty,
      CAST(pp.[Shift] AS nvarchar(20)) AS plan_no,
      pp.[Net Weight] AS weight_per_sheet,
      sl.[Unit Price] AS price_per_sheet,
      CAST(NULL AS nvarchar(200)) AS problem_name_en,
      i.[Grade Code] AS grade,
      i.[Description] AS product_name,
      pp.[T] AS t,
      pp.[Item No_] AS item_no,
      CAST(pp.[Big Sheet] AS decimal(18, 4)) AS big_sheet,
      pp.[Width (mm)] AS width_mm,
      pp.[S] AS s,
      pp.[Lenght (mm)] AS length_mm,
      pp.[Width (W)] AS width_w,
      CONCAT(
        CONVERT(nvarchar(20), CAST(COALESCE(NULLIF(pp.[Width (mm)], 0), pp.[S]) AS int)),
        N'x',
        CONVERT(nvarchar(20), CAST(pp.[Lenght (mm)] AS int))
      ) AS big_sheet_size,
      CONCAT(
        CONVERT(nvarchar(20), CAST(pp.[Width (W)] AS int)),
        N'x',
        CONVERT(nvarchar(20), CAST(pp.[Lenght (mm)] AS int))
      ) AS small_sheet_size
    FROM [LFB Golive$Production Planning] pp
    LEFT JOIN [LFB Golive$Item] i ON i.[No_] = pp.[Item No_]
    OUTER APPLY (
      SELECT TOP 1 s.[Unit Price]
      FROM [LFB Golive$Sales Line] s
      WHERE s.[Prod_ Order No_] = pp.[Prod_ Order No_]
      ORDER BY s.[Line No_]
    ) sl
    ${where}
    ORDER BY pp.[Prod_ Order No_]
  `;
}

function buildSqlMysql({ forCount }) {
  return buildSql({ forCount }).replace(/@pdr_no/g, "?");
}

function queryMock(pdrNo) {
  const all = JSON.parse(fs.readFileSync(MOCK_PATH, "utf8"));
  const rows = all.filter(
    (r) => String(r.pdr_no).toUpperCase() === String(pdrNo).toUpperCase()
  );
  return { data: rows, total: rows.length };
}

async function queryErp(config, pdrNo) {
  const driver = (config.driver || "mssql").toLowerCase();

  if (driver === "mssql") {
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
      const countReq = pool.request();
      countReq.input("pdr_no", sql.NVarChar, pdrNo);
      const countResult = await countReq.query(buildSql({ forCount: true }));
      const total = Number(countResult.recordset?.[0]?.total || 0);

      const dataReq = pool.request();
      dataReq.input("pdr_no", sql.NVarChar, pdrNo);
      const dataResult = await dataReq.query(buildSql({ forCount: false }));

      return { data: dataResult.recordset || [], total };
    } finally {
      await pool.close();
    }
  }

  if (driver === "mysql") {
    const mysql = require("mysql2/promise");
    const conn = await mysql.createConnection({
      host: config.host,
      port: config.port_db || 3306,
      database: config.database,
      user: config.user,
      password: config.password,
    });

    try {
      const [countRows] = await conn.execute(buildSqlMysql({ forCount: true }), [
        pdrNo,
      ]);
      const total = Number(countRows?.[0]?.total || 0);

      const [rows] = await conn.execute(buildSqlMysql({ forCount: false }), [
        pdrNo,
      ]);

      return { data: rows || [], total };
    } finally {
      await conn.end();
    }
  }

  throw new Error(`Unsupported driver: ${driver}`);
}

async function getPdrList({ mode, config, pdrNo }) {
  if (!pdrNo) {
    throw new Error("pdr_no is required");
  }
  // ERP / mock ตามเดิม — ไม่แก้ SQL/connection
  const result =
    mode === "erp" ? await queryErp(config, pdrNo) : queryMock(pdrNo);

  // เติม Sale/CS + Grade จาก customer_care (อ่านอย่างเดียว; ล้มเหลวแล้วข้าม)
  const data = await enrichWithCustomerCare(result.data, config);
  return { data, total: result.total };
}

module.exports = { getPdrList };
