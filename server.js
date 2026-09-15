// 中山區房價雷達 — 雲梯後端
// 職責：1) 提供顯示網頁(index.html)  2) /data/* 從資料庫讀 JSON  3) /api/ingest 收擴充推送
// 資料存在平台的 Postgres：一張 files(path, content jsonb, updated_at) 就夠(資料很小)。
const express = require("express");
const { Pool } = require("pg");
const path = require("path");

const app = express();
app.use(express.json({ limit: "6mb" }));

// 允許擴充(不同來源)呼叫 /api/ingest 與讀 /data/*
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, x-ingest-secret");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// 雲梯內網 Postgres 沒開 SSL(連 SSL 交握都會被拒)。這個 app 只跑在雲梯上，
// 所以固定關閉 SSL；真要開可設 PGSSL=1。
let pool = null;
function db() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === "1" ? { rejectUnauthorized: false } : false,
      max: 4,
    });
  }
  return pool;
}
let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = db().query(
      "CREATE TABLE IF NOT EXISTS files (path text PRIMARY KEY, content jsonb NOT NULL, updated_at timestamptz DEFAULT now())"
    ).catch((e) => { tableReady = null; throw e; });
  }
  return tableReady;
}

const INGEST_SECRET = process.env.INGEST_SECRET || "";

app.get("/healthz", (req, res) => res.json({ ok: true }));

// 讀資料：/data/latest.json、/data/history/2026-06-28.json …
app.get("/data/*", async (req, res) => {
  const p = req.params[0];
  try {
    await ensureTable();
    const r = await db().query("SELECT content FROM files WHERE path=$1", [p]);
    if (!r.rows.length) return res.status(404).json({ error: "not found", path: p });
    res.set("Cache-Control", "no-store");
    res.json(r.rows[0].content);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

// 擴充推送：POST /api/ingest  { path, content }，需帶 x-ingest-secret
app.post("/api/ingest", async (req, res) => {
  if (!INGEST_SECRET || req.get("x-ingest-secret") !== INGEST_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const p = req.body && req.body.path;
  const content = req.body && req.body.content;
  if (!p || typeof content === "undefined") {
    return res.status(400).json({ error: "need path + content" });
  }
  try {
    await ensureTable();
    await db().query(
      "INSERT INTO files (path, content, updated_at) VALUES ($1,$2,now()) " +
      "ON CONFLICT (path) DO UPDATE SET content=EXCLUDED.content, updated_at=now()",
      [p, content]
    );
    res.json({ ok: true, path: p });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

// 顯示網頁(只提供 index.html，不外露 server.js / 擴充原始碼)
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("price-radar listening on " + port));
