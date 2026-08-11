/**
 * Read-only lookup จาก MySQL customer_care
 * — SELECT อย่างเดียว ไม่ INSERT/UPDATE/DELETE
 * — ไม่แตะ connection/SQL ของ ERP (MSSQL)
 */

const mysql = require("mysql2/promise");

/** ตัดช่องว่าง จุด คำนำหน้าบริษัท ฯลฯ เพื่อเทียบชื่อใกล้เคียง */
function normalizeCompanyName(name) {
  return String(name || "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/บริษัท|จำกัด|ห้างหุ้นส่วนจำกัด|หจก\.?|บจก\.?/gi, "")
    .replace(/[.\s\-_/,\\()（）'"′″`]/g, "")
    .trim();
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  if (longer.includes(shorter) && shorter.length >= 4) {
    return shorter.length / longer.length;
  }
  // simple bigram Dice coefficient
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = new Map();
  for (let i = 0; i < a.length - 1; i += 1) {
    const gram = a.slice(i, i + 2);
    bigrams.set(gram, (bigrams.get(gram) || 0) + 1);
  }
  let match = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    const gram = b.slice(i, i + 2);
    const count = bigrams.get(gram) || 0;
    if (count > 0) {
      bigrams.set(gram, count - 1);
      match += 1;
    }
  }
  return (2 * match) / (a.length - 1 + (b.length - 1));
}

function pickBestMatch(erpCompanyName, rows, minScore = 0.82) {
  const target = normalizeCompanyName(erpCompanyName);
  if (!target) return null;

  let best = null;
  let bestScore = 0;
  for (const row of rows) {
    const cand = normalizeCompanyName(row.customer_name);
    if (!cand) continue;
    let score = 0;
    if (cand === target) score = 1;
    else score = similarity(target, cand);
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }
  if (!best || bestScore < minScore) return null;
  return { row: best, score: bestScore };
}

function formatSaleCs(saleNickname, csName) {
  const parts = [saleNickname, csName]
    .map((v) => String(v || "").trim())
    .filter(Boolean);
  return parts.length ? parts.join(" / ") : null;
}

/**
 * โหลดรายชื่อลูกค้าจาก customer_care (SELECT อย่างเดียว)
 * ตารางเล็ก (~ร้อยแถว) — โหลดครั้งเดียวต่อ request ชุด
 */
async function loadCustomerCareRows(ccConfig) {
  const conn = await mysql.createConnection({
    host: ccConfig.host,
    port: ccConfig.port || 3306,
    database: ccConfig.database,
    user: ccConfig.user,
    password: ccConfig.password,
  });

  try {
    const table = String(ccConfig.table || "customer_care").replace(
      /[^a-zA-Z0-9_]/g,
      ""
    );
    const [rows] = await conn.query(
      `SELECT customer_name, grade, sale_nickname, cs_name
       FROM \`${table}\``
    );
    return rows || [];
  } finally {
    await conn.end();
  }
}

/**
 * เติม grade / sale_nickname / cs_name / sale_cs_staff ลงแถว ERP
 * ถ้า MySQL พังหรือไม่เจอชื่อ — คืนข้อมูล ERP เดิม ไม่ throw
 */
async function enrichWithCustomerCare(data, config) {
  const cc = config.customer_care;
  if (!cc || cc.enabled === false) return data;
  if (!cc.host || !cc.database || !cc.user) return data;
  if (!Array.isArray(data) || data.length === 0) return data;

  let rows;
  try {
    rows = await loadCustomerCareRows(cc);
  } catch (err) {
    console.warn(
      "[customer_care] skip enrich (read failed):",
      err.message || err
    );
    return data;
  }

  const minScore = Number(cc.min_score || 0.82);

  return data.map((item) => {
    const match = pickBestMatch(item.company_name, rows, minScore);
    if (!match) return item;

    const { row } = match;
    const saleNickname = row.sale_nickname || null;
    const csName = row.cs_name || null;
    const grade =
      row.grade != null && String(row.grade).trim() !== ""
        ? String(row.grade).trim()
        : item.grade;

    return {
      ...item,
      // เกรดลูกค้าจาก customer_care (ทับ Item Grade เฉพาะเมื่อจับคู่ได้)
      grade,
      sale_nickname: saleNickname,
      cs_name: csName,
      sale_cs_staff: formatSaleCs(saleNickname, csName) || item.sale_cs_staff,
      customer_care_matched: row.customer_name,
    };
  });
}

module.exports = {
  enrichWithCustomerCare,
  normalizeCompanyName,
  pickBestMatch,
};
