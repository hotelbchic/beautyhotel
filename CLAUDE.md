<!-- cloudlift -->
## 這個專案(中山區房價雷達)已經在公司平台(雲梯 Cloudlift)上線
- 網址：https://price-radar.app.saltycloud.ai（slug：`price-radar`）
- 平台 API：`https://deploy.app.saltycloud.ai`，token 在 `~/.cloudlift/config.json` 的 `token` 欄位，
  每個請求帶 `Authorization: Bearer <token>`。
  看環境變數名稱 `GET /apps/price-radar/env`、看資料庫的表與列數 `GET /apps/price-radar/database/tables`、
  看有沒有接到平台外的資料庫 `GET /apps/price-radar/doctor`。
- 架構：Node(Express) 後端 `server.js`。職責：(1) `/` 提供顯示網頁 `index.html`
  (2) `GET /data/<path>` 從資料庫讀 JSON (3) `POST /api/ingest` 收 Chrome 擴充推送(需 `x-ingest-secret`)。
- 資料庫：平台的 Postgres，`DATABASE_URL` 由平台設定。**不要**設 `SUPABASE_DB_URL`／`POSTGRES_URL`。
  只有一張表 `files(path text pk, content jsonb, updated_at)`，存那幾包 JSON(latest/calendar/history/…)。
  ⚠️ 平台 Postgres 沒開 SSL，`server.js` 的 pg pool 固定 `ssl:false`(要開設 `PGSSL=1`)。
  ⚠️ 寫 jsonb 要先 `JSON.stringify`(否則 pg 把 JS 陣列當 Postgres 陣列，index.json 會炸)。
- 推送密鑰 `INGEST_SECRET`：後端用平台環境變數(`GET /env` 看得到名稱)；
  擴充端放在 **不進版控的 `extension/secret.js`**(`self.BH_INGEST_SECRET`)，避免公開的 GitHub repo 洩漏。
- 改完程式碼要上線、查狀態、看設定：一律用 cloudlift-deploy skill。不要用 Vercel／GitHub Pages 當正式站，
  也不要說「我看不到平台的設定」——上面那三支就看得到。

### 搬遷紀錄(從 GitHub Pages 搬來)
- 切換時間：2026-09-16（之後補資料以此為分界）
- 舊站：https://hotelbchic.github.io/beautyhotel/ （GitHub Pages，靜態網頁）——**保留當備份**，
  不是正式站。舊資料是 repo 裡的 `data/*.json`。至少留到 2026-09-30 再考慮收。
- 舊資料來源：Chrome 擴充原本用 GitHub Contents API 把 `data/*.json` 推到 repo。
  現在改推到雲梯 `POST /api/ingest`。舊 repo 的 data 只是搬遷前的快照。
- 外部自動化：抓價的 Chrome 擴充(`extension/`)**只裝在使用者這一台電腦**(不是各櫃檯)。
  已改成推雲梯(v2.0.0)，並重新載入。沒有別台要改。
- 排程在擴充裡(chrome.alarms)：每天 09:30 抓今日比價、每 3 天 03:00 抓 14 天日曆，都推雲梯。
<!-- /cloudlift -->

# 中山區房價雷達 — 專案說明

峻美精品旅店的競品房價比價工具。顯示台北中山區 10 間飯店的 Agoda/Trip/Booking 房價。

- **顯示網頁**：`index.html`(單頁，Chart.js CDN)。分頁：今日比價 / 14天走勢圖 / 14天日曆 /
  歷史趨勢 / 調閱歷史價格 / 調閱多日歷史價格。
- **抓價**：`extension/`(Chrome 擴充)。在 Google Travel + Agoda 抓真實房價，
  推到雲梯後端。只裝在使用者這台。
- **原則**：只顯示真實抓到的價，抓不到就留白(不推算、不亂猜)。峻美自家要湊滿 3 平台。
