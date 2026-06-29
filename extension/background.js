/* eslint-disable */
// 背景引擎：一鍵全自動抓 10 間 + 自動推 GitHub。
// 流程：建一個分頁 → 逐間導航到該飯店的 Google Travel 搜尋頁 → 叫 content-google 抓價
//       → 存 chrome.storage → 全部跑完用 bhConfig 的 token 自動推 latest.json/history。
// 為了避開 Google 反爬蟲，每間之間留間隔（人類節奏）。

const HOTELS = [
  { id: "own",     q: "峻美精品旅店 Hotel Bnight 台北" },
  { id: "bchic",   q: "台北昇美精品旅店 Hotel Bchic 中山" },
  { id: "qiancai", q: "千彩格精品旅店 Colors Inn 台北" },
  { id: "roumei",  q: "柔美商務飯店 台北 中山" },
  { id: "shemei",  q: "碩美精品旅店 Hotel Bstay 台北" },
  { id: "zhenmei", q: "台北甄美精品旅店" },
  { id: "tianjin", q: "天津大酒店 Vagus Hotel 台北" },
  { id: "yunfu",   q: "雲富大飯店 中山" },
  { id: "apt35",   q: "35APT 無人自助入住 中山" },
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
const askExtract = (tabId, expectedId, wantAll) => askContent(tabId, { type: "extractNow", expectedId, wantAll: !!wantAll });
const askSetDate = (tabId) => askContent(tabId, { type: "setDateToday" });

// Google 常漏抓的飯店 → 用 Agoda 飯店頁直連補（slug 已驗證）
const AGODA_PATHS = {
  own:     "beauty-hotels-taipei-hotel-bnight/hotel/taipei-tw.html", // 峻美 Hotel Bnight
  bchic:   "beauty-hotels-taipei-hotel-bchic/hotel/taipei-tw.html",
  qiancai: "colors-infinity-inn/hotel/taipei-tw.html",               // 千彩格 (已驗證)
  roumei:  "beauty-hotels-roumei-boutique/hotel/taipei-tw.html",     // 柔美
  shemei:  "beauty-hotels-taipei-hotel-bstay/hotel/taipei-tw.html",  // 碩美 Hotel Bstay
  zhenmei: "beauty-hotels-taipei-hotel-bfun/hotel/taipei-tw.html",   // 甄美 Hotel Bfun
  tianjin: "vagus-hotel-h64237005/hotel/taipei-tw.html",             // 天津 Vagus
  yunfu:   "yoyo-hotel_2/hotel/taipei-tw.html",                      // 雲富 Hotel Cloud
  apt35:   "35apt/hotel/taipei-tw.html",                             // 35號公寓
  napt:    "zhongshan-n-apt/hotel/taipei-tw.html",                   // 中山北棧 中山N.APT
};
const agodaURL = (path, ciISO, coISO) =>
  `https://www.agoda.com/zh-tw/${path}?checkIn=${ciISO}&checkOut=${coISO}&adults=2&los=1&priceCur=TWD`;
const askAgoda = (tabId) => askContent(tabId, { type: "extractAgoda" });

// 區間掃描用：Agoda 直連優先(未來日期 Google 會被擋)，抓不到才退回 Google
async function scrapeAgodaFirst(tabId, h, ts, ciISO, coISO) {
  if (AGODA_PATHS[h.id]) {
    await chrome.tabs.update(tabId, { url: agodaURL(AGODA_PATHS[h.id], ciISO, coISO) });
    await waitTabComplete(tabId);
    await sleep(3000);
    const a = await askAgoda(tabId);
    if (a && a.price) {
      return { hotelId: h.id, hotelName: h.id, dates: [ciISO.slice(5), coISO.slice(5)], prices: { agoda: a.price }, source: "agoda" };
    }
  }
  return await scrapeOnce(tabId, h.q, h.id, ts); // Agoda 失敗才試 Google
}

// 今日比價用：先 Google 抓；漏抓且有 Agoda slug 就改抓 Agoda 飯店頁
async function scrapeWithFallback(tabId, h, ts, ciISO, coISO, wantAll) {
  const d = await scrapeOnce(tabId, h.q, h.id, ts, wantAll);
  if (d && d.prices && Object.keys(d.prices).length) return d;
  if (AGODA_PATHS[h.id]) {
    await chrome.tabs.update(tabId, { url: agodaURL(AGODA_PATHS[h.id], ciISO, coISO) });
    await waitTabComplete(tabId);
    await sleep(3500);
    const a = await askAgoda(tabId);
    if (a && a.price) {
      return { hotelId: h.id, hotelName: h.id, dates: [ciISO.slice(5), coISO.slice(5)], prices: { agoda: a.price }, source: "agoda" };
    }
  }
  return d;
}

// 導航到某飯店該日 → 抓價；抓不到(載慢/504)就重載重試一次
async function scrapeOnce(tabId, q, expectedId, ts, wantAll) {
  const url = gtURL(q, ts);
  await chrome.tabs.update(tabId, { url });
  await waitTabComplete(tabId);
  await sleep(3000);
  let d = await askExtract(tabId, expectedId, wantAll);
  // 自家要 3 平台：抓不到、或還沒湊滿 3 家，就重載再試一次
  const enough = (x) => x && x.prices && Object.keys(x.prices).length >= (wantAll ? 3 : 1);
  if (!enough(d)) {
    await sleep(2500);
    await chrome.tabs.update(tabId, { url: url + "&_r=1" });
    await waitTabComplete(tabId);
    await sleep(4000);
    const d2 = await askExtract(tabId, expectedId, wantAll);
    // 取平台數較多的那次
    if (d2 && d2.prices && (!d || Object.keys(d2.prices).length > Object.keys(d.prices || {}).length)) d = d2;
  }
  return d;
}

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

async function autoPush(preferredCheckin) {
  const cfg = await getCfg();
  if (!cfg.token) return { ok: false, reason: "沒設定 GitHub Token，已抓到的資料留在擴充裡，可手動推送" };
  cfg.repo = cfg.repo || "hotelbchic/beautyhotel";
  cfg.branch = cfg.branch || "main";
  const scrapes = await getScrapes();
  let checkin;
  // 若呼叫端指定了入住日（如每日排程＝今天），就用它，避免被舊的區間資料蓋過
  if (preferredCheckin && scrapes.some((e) => e.checkin === preferredCheckin)) {
    checkin = preferredCheckin;
  } else {
    // 否則退回「最常見的入住日」
    const counts = {};
    scrapes.forEach((e) => { if (e.checkin) counts[e.checkin] = (counts[e.checkin] || 0) + 1; });
    checkin = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  }
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
  const ci0 = dayFromOffset(baseISO, 0), co0 = dayFromOffset(baseISO, 1);
  const ciISO = `${ci0.y}-${String(ci0.m).padStart(2, "0")}-${String(ci0.d).padStart(2, "0")}`;
  const coISO = `${co0.y}-${String(co0.m).padStart(2, "0")}-${String(co0.d).padStart(2, "0")}`;
  let win;
  try {
    win = await openScanWindow();
    for (let i = 0; i < HOTELS.length; i++) {
      const h = HOTELS[i];
      await progress(i + 1, HOTELS.length, `搜尋 ${h.id}（今天）…`, { ok: ok.length, skip: skip.length });
      // 自家峻美(own)要求湊滿 Agoda/Trip/Booking 三平台
      const d = await scrapeWithFallback(win.tabId, h, ts, ciISO, coISO, h.id === "own");
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
      // 明確指定「今天入住」當這份快照的日期，避免被舊的區間掃描資料蓋過
      const todayCheckin = `${String(ci0.m).padStart(2, "0")}-${String(ci0.d).padStart(2, "0")}`;
      const pr = await autoPush(todayCheckin);
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

// ===== 日期區間掃描（最多 14 天，每天都抓真實價）=====
// 存 data/calendar.json：{ days: { "YYYY-MM-DD": { hotelId: price } } }，頁面直接照日期顯示，不內插。
function listDates(startISO, endISO) {
  const [sy, sm, sd] = startISO.split("-").map(Number);
  const [ey, em, ed] = endISO.split("-").map(Number);
  const start = new Date(sy, sm - 1, sd), end = new Date(ey, em - 1, ed);
  const out = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
    const d = new Date(t);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
    if (out.length >= 14) break; // 安全上限
  }
  return out;
}

async function runRangeScan(startISO, endISO) {
  if (RUNNING) return;
  RUNNING = true;
  const dateList = listDates(startISO, endISO);
  const days = {};
  const total = dateList.length * HOTELS.length;
  let done = 0, okCount = 0;
  let win;
  try {
    win = await openScanWindow();
    for (const iso of dateList) {
      const [Y, M, D] = iso.split("-").map(Number);
      const co = new Date(Y, M - 1, D + 1);
      const coISO = `${co.getFullYear()}-${String(co.getMonth() + 1).padStart(2, "0")}-${String(co.getDate()).padStart(2, "0")}`;
      const ts = buildTs({ y: Y, m: M, d: D }, { y: co.getFullYear(), m: co.getMonth() + 1, d: co.getDate() });
      days[iso] = {};
      for (const h of HOTELS) {
        done++;
        await progress(done, total, `${iso.slice(5)} · ${h.id}`, { ok: okCount });
        const d = await scrapeAgodaFirst(win.tabId, h, ts, iso, coISO);
        if (d && d.prices && Object.keys(d.prices).length) {
          days[iso][h.id] = Math.min(...Object.values(d.prices).filter((x) => typeof x === "number"));
          okCount++;
        }
        await sleep(5000);
      }
    }
    await setStatus({ running: true, i: total, total, msg: "推送區間房價到 GitHub…", ok: okCount });
    let pushMsg;
    try {
      const cfg = await getCfg();
      if (!cfg.token) pushMsg = "未推送：沒設 GitHub Token";
      else {
        cfg.repo = cfg.repo || "hotelbchic/beautyhotel"; cfg.branch = cfg.branch || "main";
        // 合併：先讀雲端現有的 days，把這次的疊上去(不覆蓋掉之前抓的其他日期)
        let mergedDays = {};
        try {
          const cur = await ghGetSha("data/calendar.json", cfg);
          if (cur.json && cur.json.days) mergedDays = cur.json.days;
        } catch (e) {}
        Object.keys(days).forEach((d) => { mergedDays[d] = days[d]; }); // 新的覆蓋同一天、其餘保留
        // 清掉今天以前的舊日期(過期沒意義、也避免無限長大)
        const todayStr = todayISO();
        Object.keys(mergedDays).forEach((d) => { if (d < todayStr) delete mergedDays[d]; });
        const allDates = Object.keys(mergedDays).sort();
        const obj = { schemaVersion: 2, version: Date.now(), lastUpdated: new Date().toISOString(),
          rangeStart: allDates[0] || startISO, rangeEnd: allDates[allDates.length - 1] || dateList[dateList.length - 1], days: mergedDays };
        await ghPut("data/calendar.json", obj, `data: 區間房價合併 ${startISO}~${dateList[dateList.length - 1]} (auto)`, cfg);
        // 另存一份「以查詢日命名」的整張表快照，給比價表「📆 調閱多日歷史價格」回看
        try {
          await ghPut(`data/calendar-history/${todayStr}.json`, obj, `data: 多日歷史快照 ${todayStr} (auto)`, cfg);
          const cidx = await ghGetSha("data/calendar-history/index.json", cfg);
          const clist = Array.isArray(cidx.json) ? cidx.json : [];
          if (!clist.includes(todayStr)) clist.push(todayStr);
          clist.sort();
          await ghPut("data/calendar-history/index.json", clist, `data: 更新多日歷史索引 ${todayStr} (auto)`, cfg, cidx.sha);
        } catch (e) {}
        // 注意：區間掃描只更新 14天日曆，不碰今日比價(今日比價的 3 OTA 由「一鍵全抓」負責，
        // 避免區間的 Agoda 單價蓋掉今日的三家價)
        pushMsg = "已推送(合併)，14天日曆更新(今日比價請用一鍵全抓)";
      }
    } catch (e) { pushMsg = `推送失敗：${(e && e.message) || e}`; }
    await setStatus({ running: false, done: true, i: total, total,
      msg: `🎉 區間完成：${okCount}/${total} 點（${dateList.length} 天）。${pushMsg}`, ok: okCount });
  } catch (e) {
    await setStatus({ running: false, done: true, error: true, msg: `❌ 中斷：${(e && e.message) || e}`, ts: Date.now() });
  } finally {
    RUNNING = false;
    if (win) await closeWindow(win.winId);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "startRangeScan") {
    if (RUNNING) { sendResponse({ started: false, reason: "already running" }); return; }
    runRangeScan(msg.startISO, msg.endISO);
    sendResponse({ started: true });
    return;
  }
  if (msg && msg.type === "setupAlarm") { setupDailyAlarm(); sendResponse({ ok: true }); return; }
});

// ===== 每天自動排程(chrome.alarms) =====
// 預設啟用、每天 08:00 自動跑 runAutoBatch(抓今天10間 + 推雲端)。
// 限制：這台電腦+Chrome 要開著、到時間才會跑。
function setupDailyAlarm() {
  chrome.storage.local.get(["bhConfig"], (r) => {
    const cfg = r.bhConfig || {};
    chrome.alarms.clear("bhDailyScan");
    if (cfg.scheduleEnabled === false) return; // 關閉排程
    const hour = (typeof cfg.scheduleHour === "number") ? cfg.scheduleHour : 9;     // 預設 09:30
    const minute = (typeof cfg.scheduleMinute === "number") ? cfg.scheduleMinute : 30;
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1); // 今天該時間已過 → 明天
    chrome.alarms.create("bhDailyScan", { when: next.getTime(), periodInMinutes: 1440 }); // 每天
  });
}
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "bhDailyScan") runAutoBatch(); // 自動抓今天 + 推雲端
});
chrome.runtime.onStartup.addListener(setupDailyAlarm);
chrome.runtime.onInstalled.addListener(() => {
  console.log("beautyhotel-sync background ready");
  // 首次安裝/更新時，若還沒設定過排程，預設開啟每天 8 點
  chrome.storage.local.get(["bhConfig"], (r) => {
    const cfg = r.bhConfig || {};
    if (cfg.scheduleEnabled === undefined) {
      cfg.scheduleEnabled = true;
      if (typeof cfg.scheduleHour !== "number") cfg.scheduleHour = 9;
      if (typeof cfg.scheduleMinute !== "number") cfg.scheduleMinute = 30;
      chrome.storage.local.set({ bhConfig: cfg }, setupDailyAlarm);
    } else {
      setupDailyAlarm();
    }
  });
});
