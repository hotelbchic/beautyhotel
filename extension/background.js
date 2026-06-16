/* eslint-disable */
// 背景引擎：一鍵全自動抓 10 間 + 自動推 GitHub。
// 流程：建一個分頁 → 逐間導航到該飯店的 Google Travel 搜尋頁 → 叫 content-google 抓價
//       → 存 chrome.storage → 全部跑完用 bhConfig 的 token 自動推 latest.json/history。
// 為了避開 Google 反爬蟲，每間之間留間隔（人類節奏）。

const HOTELS = [
  { id: "own",     q: "峻美精品旅店 Hotel Bnight 台北" },
  { id: "bchic",   q: "台北昇美精品旅店 Hotel Bchic" },
  { id: "qiancai", q: "千彩格精品旅店 Colors Inn 台北" },
  { id: "roumei",  q: "柔美商務飯店 台北 中山" },
  { id: "shemei",  q: "碩美精品旅店 Hotel Bstay 台北" },
  { id: "zhenmei", q: "甄美精品商旅 台北" },
  { id: "tianjin", q: "天津大酒店 Vagus Hotel 台北" },
  { id: "yunfu",   q: "雲富大飯店 Hotel Cloud 台北" },
  { id: "apt35",   q: "35APT 台北 中山" },
  { id: "napt",    q: "中山N.APT 台北" },
];
const ALL_IDS = HOTELS.map((h) => h.id);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gtURL = (q, ts) =>
  `https://www.google.com/travel/search?q=${encodeURIComponent(q)}&hl=zh-TW&gl=tw` +
  (ts ? `&ts=${ts}` : "");

// 從使用者已開的 Google Travel 分頁網址，撈出日期參數 ts（使用者設好今天後就在裡面）
function findUserDateTs() {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: "*://www.google.com/travel/*" }, (tabs) => {
      for (const t of tabs || []) {
        const m = (t.url || "").match(/[?&]ts=([^&]+)/);
        if (m) return resolve(m[1]);
      }
      resolve(null);
    });
  });
}

let RUNNING = false;

function setStatus(obj) {
  return new Promise((r) => chrome.storage.local.set({ bhAutoStatus: obj }, r));
}
function progress(i, total, msg, extra) {
  return setStatus(Object.assign({ running: true, i, total, msg, ts: Date.now() }, extra || {}));
}

// ---- storage ----
function storeScrape(d) {
  return new Promise((resolve) => {
    chrome.storage.local.get(["bhScrapes"], (r) => {
      const arr = r.bhScrapes || [];
      const entry = {
        hotelId: d.hotelId,
        hotelName: d.hotelName,
        checkin: (d.dates && d.dates[0]) || null,
        checkout: (d.dates && d.dates[1]) || null,
        prices: d.prices,
        ts: Date.now(),
      };
      const key = (e) => e.hotelId + "@" + e.checkin;
      const filtered = arr.filter((e) => key(e) !== key(entry));
      filtered.push(entry);
      chrome.storage.local.set({ bhScrapes: filtered }, () => resolve(filtered.length));
    });
  });
}
const getScrapes = () => new Promise((r) => chrome.storage.local.get(["bhScrapes"], (o) => r(o.bhScrapes || [])));
const getCfg = () => new Promise((r) => chrome.storage.local.get(["bhConfig"], (o) => r(o.bhConfig || {})));

// ---- 等分頁載入完成 ----
function waitTabComplete(tabId, timeout = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const to = setTimeout(finish, timeout);
    function finish(ok) {
      if (done) return;
      done = true;
      clearTimeout(to);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(!!ok);
    }
    function listener(id, info) {
      if (id === tabId && info.status === "complete") finish(true);
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ---- 叫 content-google 做事（抓價 / 設日期）；content 還沒注入好會重試 ----
function askContent(tabId, payload, tries = 10) {
  return new Promise((resolve) => {
    let n = 0;
    function attempt() {
      chrome.tabs.sendMessage(tabId, payload, (resp) => {
        if (chrome.runtime.lastError) {
          if (n++ < tries) setTimeout(attempt, 1500);
          else resolve(null);
          return;
        }
        resolve(resp || null);
      });
    }
    attempt();
  });
}
const askExtract = (tabId, expectedId) => askContent(tabId, { type: "extractNow", expectedId });
const askSetDate = (tabId) => askContent(tabId, { type: "setDateToday" });

// ---- GitHub 推送（service worker 版，與 popup 邏輯一致）----
function utf8ToBase64(str) {
  // service worker 沒有 unescape，用 TextEncoder
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}
async function ghGetSha(path, cfg) {
  const base = `https://api.github.com/repos/${cfg.repo}/contents/${path}`;
  const headers = { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json" };
  const res = await fetch(`${base}?ref=${encodeURIComponent(cfg.branch)}`, { headers });
  if (res.status === 404) return { sha: undefined, json: null };
  if (!res.ok) throw new Error(`讀取 ${path} 失敗 ${res.status}`);
  const j = await res.json();
  let json = null;
  try { json = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(j.content), (c) => c.charCodeAt(0)))); } catch (e) {}
  return { sha: j.sha, json };
}
async function ghPut(path, obj, message, cfg, sha) {
  const base = `https://api.github.com/repos/${cfg.repo}/contents/${path}`;
  const headers = { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" };
  if (sha === undefined) sha = (await ghGetSha(path, cfg)).sha;
  const body = { message, content: utf8ToBase64(JSON.stringify(obj, null, 2)), branch: cfg.branch };
  if (sha) body.sha = sha;
  const res = await fetch(base, { method: "PUT", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`寫入 ${path} 失敗 ${res.status} ${(await res.text()).slice(0, 100)}`);
  return res.json();
}
function buildSnapshot(checkin, scrapes) {
  const forDate = scrapes.filter((e) => e.checkin === checkin);
  const hotels = {};
  ALL_IDS.forEach((id) => (hotels[id] = { agoda: null, trip: null, booking: null }));
  forDate.forEach((e) => {
    hotels[e.hotelId] = {
      agoda: e.prices.agoda ?? null,
      trip: e.prices.trip ?? null,
      booking: e.prices.booking ?? null,
    };
  });
  let checkout = null, dayOfWeek = "", isWeekend = false;
  const m = checkin && checkin.match(/(\d{2})-(\d{2})/);
  if (m) {
    const year = new Date().getFullYear();
    const ci = new Date(year, +m[1] - 1, +m[2]);
    const co = new Date(ci.getTime() + 86400000);
    checkout = `${String(co.getMonth() + 1).padStart(2, "0")}-${String(co.getDate()).padStart(2, "0")}`;
    dayOfWeek = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"][ci.getDay()];
    isWeekend = ci.getDay() === 5 || ci.getDay() === 6;
  }
  const now = new Date();
  const scrapeDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return { schemaVersion: 1, lastUpdated: now.toISOString(), scrapeDate, checkin, checkout, dayOfWeek, isWeekend, source: "auto-batch", hotels };
}

async function autoPush() {
  const cfg = await getCfg();
  if (!cfg.token) return { ok: false, reason: "沒設定 GitHub Token，已抓到的資料留在擴充裡，可手動推送" };
  cfg.repo = cfg.repo || "hotelbchic/beautyhotel";
  cfg.branch = cfg.branch || "main";
  const scrapes = await getScrapes();
  // 取「這次最常見的入住日」當這份快照的日期
  const counts = {};
  scrapes.forEach((e) => { if (e.checkin) counts[e.checkin] = (counts[e.checkin] || 0) + 1; });
  const checkin = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  if (!checkin) return { ok: false, reason: "沒有可推送的日期" };
  const snap = buildSnapshot(checkin, scrapes);
  const sd = snap.scrapeDate;
  await ghPut("data/latest.json", snap, `data: 一鍵更新 ${checkin} (auto)`, cfg);
  await ghPut(`data/history/${sd}.json`, snap, `data: 歷史快照 ${sd} (auto)`, cfg);
  const idx = await ghGetSha("data/history/index.json", cfg);
  const list = Array.isArray(idx.json) ? idx.json : [];
  if (!list.includes(sd)) list.push(sd);
  list.sort();
  await ghPut("data/history/index.json", list, `data: 更新歷史索引 ${sd} (auto)`, cfg, idx.sha);
  return { ok: true, checkin };
}

// ---- 主流程 ----
async function runAutoBatch() {
  if (RUNNING) return;
  RUNNING = true;
  const ok = [], skip = [];
  let tabId;
  // 先撈使用者已設好的日期（從現有 Google Travel 分頁網址的 ts 參數）
  const userTs = await findUserDateTs();
  if (!userTs) {
    await setStatus({
      running: false, done: true, error: true, ts: Date.now(),
      msg: "❌ 找不到日期。請先開一個 Google Travel 分頁、搜「台北中山區飯店」並把入住日設成今天，保持那個分頁開著，再按一次一鍵全抓。",
    });
    RUNNING = false;
    return;
  }
  try {
    const tab = await chrome.tabs.create({ url: "about:blank", active: true });
    tabId = tab.id;
    for (let i = 0; i < HOTELS.length; i++) {
      const h = HOTELS[i];
      await progress(i + 1, HOTELS.length, `開啟 ${h.id}（沿用你設的日期）…`, { ok: ok.length, skip: skip.length });
      await chrome.tabs.update(tabId, { url: gtURL(h.q, userTs) });
      await waitTabComplete(tabId);
      await sleep(2500); // 給 SPA 一點時間
      const d = await askExtract(tabId, h.id);
      if (d && d.hotelId && d.prices && Object.keys(d.prices).length) {
        const n = await storeScrape(d);
        ok.push(h.id);
        await progress(i + 1, HOTELS.length, `✅ ${h.id} 已抓（累計 ${n} 筆）`, { ok: ok.length, skip: skip.length });
      } else {
        skip.push(h.id);
        await progress(i + 1, HOTELS.length, `⚠️ ${h.id} 跳過`, { ok: ok.length, skip: skip.length });
      }
      await sleep(5000); // 人類節奏間隔，降低被擋
    }
    // 自動推送
    await setStatus({ running: true, i: HOTELS.length, total: HOTELS.length, msg: "推送到 GitHub…", ok: ok.length, skip: skip.length, ts: Date.now() });
    let pushMsg;
    try {
      const pr = await autoPush();
      pushMsg = pr.ok ? `已推送（入住日 ${pr.checkin}）手機開比價表即可看到` : `未推送：${pr.reason}`;
    } catch (e) {
      pushMsg = `推送失敗：${(e && e.message) || e}`;
    }
    await setStatus({
      running: false, done: true, i: HOTELS.length, total: HOTELS.length,
      msg: `🎉 完成：成功 ${ok.length} 間${skip.length ? `，跳過 ${skip.length}（${skip.join(",")}）` : ""}。${pushMsg}`,
      ok: ok.length, skip: skip.length, ts: Date.now(),
    });
  } catch (e) {
    await setStatus({ running: false, done: true, error: true, msg: `❌ 中斷：${(e && e.message) || e}`, ts: Date.now() });
  } finally {
    RUNNING = false;
    // 跑完留著分頁讓使用者看最後一間；不自動關，避免誤關
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "startAutoBatch") {
    if (RUNNING) { sendResponse({ started: false, reason: "already running" }); return; }
    runAutoBatch();
    sendResponse({ started: true });
    return; // 同步回覆即可
  }
  if (msg && msg.type === "getAutoStatus") {
    chrome.storage.local.get(["bhAutoStatus"], (r) => sendResponse(r.bhAutoStatus || null));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => console.log("beautyhotel-sync background ready"));
