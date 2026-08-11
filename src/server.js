/**
 * API endpoint — พี่ ERP แก้ config.json + src/pdrDb.js เป็นหลัก
 * mode ใน config.json: "mock" | "erp"
 *
 * GET /api/pdr?pdr_no=...                 ค้นด้วยเลข PDR เท่านั้น (บังคับ)
 * GET /api/orders?from=YYYY-MM-DD&to=...  ดึง PDR/PDW ทีละเดือน ตามวันตีบิล
 * GET /health
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const { getPdrList } = require("./pdrDb");
const { getOrderList } = require("./orderDb");

const ROOT = path.join(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config.json");

if (!fs.existsSync(CONFIG_PATH)) {
  console.error("ไม่พบ config.json");
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const mode =
  String(config.mode || "mock").toLowerCase() === "erp" ? "erp" : "mock";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    mode,
    port: config.port || 3100,
  });
});

app.get("/api/orders", async (req, res) => {
  const from = (req.query.from || "").trim() || null;
  const to = (req.query.to || "").trim() || null;

  try {
    const result = await getOrderList({ mode, config, from, to });
    res.json({
      ok: true,
      ...result,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) console.error("[GET /api/orders]", err);
    res.status(status).json({
      ok: false,
      from,
      to,
      total: 0,
      total_pdr: 0,
      total_pdw: 0,
      data: [],
      error: String(err.message || err),
    });
  }
});

app.get("/api/pdr", async (req, res) => {
  const pdrNo = (req.query.pdr_no || "").trim() || null;

  if (!pdrNo) {
    return res.status(400).json({
      ok: false,
      pdr_no: null,
      total: 0,
      data: [],
      error: "ต้องระบุ pdr_no เช่น /api/pdr?pdr_no=PDR2308-02377",
    });
  }

  try {
    const { data, total } = await getPdrList({
      mode,
      config,
      pdrNo,
    });

    res.json({
      ok: true,
      pdr_no: pdrNo,
      total,
      data,
    });
  } catch (err) {
    console.error("[GET /api/pdr]", err);
    res.status(500).json({
      ok: false,
      pdr_no: pdrNo,
      total: 0,
      data: [],
      error: String(err.message || err),
    });
  }
});

const port = config.port || 3100;
app.listen(port, () => {
  console.log(`PDR ERP API http://localhost:${port} mode=${mode}`);
});
