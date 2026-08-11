# API ดึง PDR จาก ERP (ตัวอย่าง)

ใส่ `config.json` → `"mode": "erp"` + แก้ SQL ใน `src/pdrDb.js` → `npm start` → ส่ง URL มา  
ชื่อคอลัมน์ตาม ERP ของได้เลย — ฝั่ง CMS จะแมปเอง

หลังดึง ERP จะ **อ่านอย่างเดียว** จาก MySQL `customer_care` แล้วจับคู่ชื่อบริษัท
เพื่อเติม `grade` / `sale_nickname` / `cs_name` / `sale_cs_staff`  
(ไม่เขียน ERP และไม่เขียน customer_care)

## โครงสร้าง

```text
config.json
sample-response.json
src/
  server.js          # เส้น API
  pdrDb.js           # SQL / ERP  ← แก้ตรงนี้
  orderDb.js         # ดึง PDR/PDW ทีละเดือน
  customerCare.js    # MySQL customer_care (SELECT อย่างเดียว)
  mock-data.json
sync-orders.js       # ดึงทีละเดือน พัก 20 วิ แล้ว insert CMS
```

## เรียก API

```text
GET /api/pdr?pdr_no=PDR2512-10940   ← บังคับมี pdr_no
GET /api/orders?from=2026-01-01&to=2026-01-31
GET /health
```

`/api/pdr` ไม่มีเส้นดึงทั้งหมด (ตัดออกแล้ว กันโหลด DB)

`/api/orders` ดึงเฉพาะ PDR/PDW ตาม `[Shipment Date]` ทีละเดือน ใบซ้ำนับ 1  
ใช้ให้ CMS upsert ลง `order_daily_count`

```text
ม.ค.  GET /api/orders?from=2026-01-01&to=2026-01-31
ก.พ.  GET /api/orders?from=2026-02-01&to=2026-02-28
...
ส.ค.  GET /api/orders?from=2026-08-01&to=เมื่อวาน
```

ของเก่าทั้งปี: `npm run sync-orders-backfill` (ทีละเดือน พัก 20 วินาที)

ของใหม่ทุกวันตี 2: Task Scheduler รัน `sync-orders-daily.cmd`  
ดึงย้อนแค่ **3 วันถึงเมื่อวาน** อ่าน ERP อย่างเดียว แล้ว upsert CMS

ดูผลที่ `logs/sync-orders.log`

## รัน

Node.js **>= 16**

```bash
npm install
npm start
```
