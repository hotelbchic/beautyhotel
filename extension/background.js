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
  `https://www.google.com/travel/search?q=${encodeURIComponent(q)}&hl=zh-TW&gl=tw` + (ts ? `&ts=${ts}` : "");

// 用 protobuf 組出 Google Travel 的日期參數 ts（已實測：可精準設定任意入住日）
function _vint(n) { const o = []; while (n > 127) { o.push((n & 127) | 128); n = Math.floor(n / 128); } o.push(n); return o; }
function _LD(f, b) { return [(f << 3) | 2].concat(_vint(b.length)).concat(b); }
function _V(f, n) { return [(f << 3) | 0].concat(_vint(n)); }
function _dateMsg(y, m, d) { return _V(1, y).concat(_V(2, m)).concat(_V(3, d)); }
function buildTs(ci, co) {
  const stay = _LD(1, _dateMsg(ci.y, ci.m, ci.d)).concat(_LD(2, _dateMsg(co.y, co.m, co.d)));
  const B = _LD(2, stay).concat(_LD(6, _V(1, 2)));
  const top = _V(1, 0).concat(_LD(3, _LD(2, B))).concat(_LD(5, _LD(1, _LD(7, [0x54, 0x57, 0x44]))));
  let s = ""; top.forEach((x) => (s += String.fromCharCode(x)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
// 把 baseDate(YYYY-MM-DD) + 偏移天數 → {y,m,d}
function dayFromOffset(baseISO, off) {
  const [Y, M, D] = baseISO.split("-").map(Number);
  const d = new Date(Y, M - 1, D + off);
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), dow: d.getDay() };
}
function todayISO() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}
function tsForOffset(baseISO, off) {
  const ci = dayFromOffset(baseISO, off), co = dayFromOffset(baseISO, off + 1);
  return buildTs({ y: ci.y, m: ci.m, d: ci.d }, { y: co.y, m: co.m, d: co.d });
}
// 開一個新視窗來跑(不佔用使用者分頁)；跑完用 closeWindow 關掉
async function openScanWindow() {
  const w = await chrome.windows.create({ url: "about:blank", focused: true, width: 1100, height: 850 });
  return { winId: w.id, tabId: w.tabs[0].id };
}
async function closeWindow(winId) { try { await chrome.windows.remove(winId); } catch (e) {} }

// 找使用者已開好、且設好日期的 Google Travel 分頁，回傳 tabId。
// 關鍵：日期只在「同一分頁內換搜尋」才會保留，所以要重用這個分頁、不要開新分頁。
function findUserTravelTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: "*://www.google.com/travel/*" }, (tabs) => {
      resolve(tabs && tabs.length ? tabs[0].id : null);
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
  // 開新視窗、用 ts 強制設成「今天」入住，不佔用使用者分頁；跑完自動關閉
  const baseISO = todayISO();
  const ts = tsForOffset(baseISO, 0);
  let win;
  try {
    win = await openScanWindow();
    for (let i = 0; i < HOTELS.length; i++) {
      const h = HOTELS[i];
      await progress(i + 1, HOTELS.length, `搜尋 ${h.id}（今天）…`, { ok: ok.length, skip: skip.length });
      await chrome.tabs.update(win.tabId, { url: gtURL(h.q, ts) });
      await waitTabComplete(win.tabId);
      await sleep(3000); // 給 SPA 載入價格
      const d = await askExtract(win.tabId, h.id);
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
    if (win) await closeWindow(win.winId); // 跑完自動關閉視窗
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

// ===== 30 天智慧取樣 =====
// 抓未來幾個代表日(平日+週末)×10 間，存成 data/calendar.json；頁面再內插補滿 30 天。
// 取樣偏移(天)：涵蓋未來 ~4 週、平日與週末都有
const SAMPLE_OFFSETS = [0, 2, 4, 9, 11, 16, 18, 23, 25, 29];

async function ghPutCalendar(baseISO, samples, cfg) {
  // samples: { offset: { hotelId: price } }
  const obj = {
    schemaVersion: 1,
    version: Date.now(),
    lastUpdated: new Date().toISOString(),
    baseDate: baseISO,
    offsets: SAMPLE_OFFSETS,
    samples, // 真實取樣點
  };
  await ghPut("data/calendar.json", obj, `data: 30天取樣 ${baseISO} (auto)`, cfg);
}

async function runSampleScan() {
  if (RUNNING) return;
  RUNNING = true;
  const baseISO = todayISO();
  const samples = {};
  const total = SAMPLE_OFFSETS.length * HOTELS.length;
  let done = 0, okCount = 0;
  let win;
  try {
    win = await openScanWindow(); // 開新視窗跑，跑完自動關
    for (const off of SAMPLE_OFFSETS) {
      const ts = tsForOffset(baseISO, off);
      samples[off] = {};
      for (const h of HOTELS) {
        done++;
        await progress(done, total, `第 +${off} 天 · ${h.id}`, { ok: okCount });
        await chrome.tabs.update(win.tabId, { url: gtURL(h.q, ts) });
        await waitTabComplete(win.tabId);
        await sleep(2500);
        const d = await askExtract(win.tabId, h.id);
        if (d && d.prices && Object.keys(d.prices).length) {
          const v = Math.min(...Object.values(d.prices).filter((x) => typeof x === "number"));
          samples[off][h.id] = v;
          okCount++;
        }
        await sleep(3500); // 對 Google 友善
      }
    }
    await setStatus({ running: true, i: total, total, msg: "推送 30 天取樣到 GitHub…", ok: okCount });
    let pushMsg;
    try {
      const cfg = await getCfg();
      if (!cfg.token) pushMsg = "未推送：沒設 GitHub Token";
      else { cfg.repo = cfg.repo || "hotelbchic/beautyhotel"; cfg.branch = cfg.branch || "main"; await ghPutCalendar(baseISO, samples, cfg); pushMsg = "已推送，比價表 30 天分頁會用真實取樣"; }
    } catch (e) { pushMsg = `推送失敗：${(e && e.message) || e}`; }
    await setStatus({ running: false, done: true, i: total, total,
      msg: `🎉 30 天取樣完成：${okCount}/${total} 點。${pushMsg}`, ok: okCount });
  } catch (e) {
    await setStatus({ running: false, done: true, error: true, msg: `❌ 中斷：${(e && e.message) || e}`, ts: Date.now() });
  } finally {
    RUNNING = false;
    if (win) await closeWindow(win.winId); // 跑完自動關閉視窗
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "startSampleScan") {
    if (RUNNING) { sendResponse({ started: false, reason: "already running" }); return; }
    runSampleScan();
    sendResponse({ started: true });
    return;
  }
});

chrome.runtime.onInstalled.addListener(() => console.log("beautyhotel-sync background ready"));
