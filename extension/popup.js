/* eslint-disable */
// popup：顯示已抓資料、儲存 GitHub 設定、把抓到的房價推送到 repo 的 data/latest.json
// + data/history/<入住日>.json（給 Phase D 歷史趨勢用）。

const ALL_IDS = ["own","bchic","qiancai","roumei","shemei","zhenmei","tianjin","yunfu","apt35","napt"];
const CFG_KEY = "bhConfig";

const $ = (id) => document.getElementById(id);
const getScrapes = () => new Promise((r) => chrome.storage.local.get(["bhScrapes"], (o) => r(o.bhScrapes || [])));
const getCfg = () => new Promise((r) => chrome.storage.local.get([CFG_KEY], (o) => r(o[CFG_KEY] || {})));

function setStatus(el, msg, kind) {
  el.className = "status show " + (kind || "info");
  el.innerHTML = msg;
}
function clearStatus(el) { el.className = "status"; el.innerHTML = ""; }

// ---- 列表 + 日期下拉 ----
async function render() {
  const arr = await getScrapes();
  $("count").textContent = arr.length;

  // 列表（依時間新到舊，top 20）
  const listEl = $("list");
  if (arr.length === 0) {
    listEl.innerHTML = `<div class="empty">尚未抓取任何資料</div>`;
  } else {
    const sorted = [...arr].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 20);
    listEl.innerHTML = sorted.map((e) => {
      const vals = Object.values(e.prices).filter((v) => typeof v === "number");
      const min = vals.length ? Math.min(...vals) : "—";
      return `<div class="row">
        <div><div class="name">${e.hotelId}</div><div class="date">${e.checkin || "?"}</div></div>
        <div style="text-align:right;font-weight:700;">$${min}</div>
      </div>`;
    }).join("");
  }

  // 入住日下拉（distinct checkin，依該日最新 scrape 時間排序）
  const sel = $("pushDate");
  const byDate = {};
  arr.forEach((e) => {
    if (!e.checkin) return;
    if (!byDate[e.checkin]) byDate[e.checkin] = { count: 0, ts: 0 };
    byDate[e.checkin].count++;
    byDate[e.checkin].ts = Math.max(byDate[e.checkin].ts, e.ts || 0);
  });
  const dates = Object.keys(byDate).sort((a, b) => byDate[b].ts - byDate[a].ts);
  sel.innerHTML = dates.length
    ? dates.map((d) => `<option value="${d}">${d}（${byDate[d].count} 間）</option>`).join("")
    : `<option value="">尚無資料</option>`;
  $("push").disabled = dates.length === 0;
}

// ---- 把某入住日的 scrapes 組成 latest.json 結構 ----
async function buildSnapshot(checkin) {
  const arr = await getScrapes();
  const forDate = arr.filter((e) => e.checkin === checkin);
  const hotels = {};
  ALL_IDS.forEach((id) => { hotels[id] = { agoda: null, trip: null, booking: null }; });
  forDate.forEach((e) => {
    hotels[e.hotelId] = {
      agoda: e.prices.agoda ?? null,
      trip: e.prices.trip ?? null,
      booking: e.prices.booking ?? null,
    };
  });
  // checkout = checkin + 1 天；星期幾與週末判斷（checkin 格式 MM-DD，補今年年份）
  let checkout = null, dayOfWeek = "", isWeekend = false;
  const m = checkin.match(/(\d{2})-(\d{2})/);
  if (m) {
    const year = new Date().getFullYear();
    const ci = new Date(year, +m[1] - 1, +m[2]);
    const co = new Date(ci.getTime() + 86400000);
    checkout = `${String(co.getMonth() + 1).padStart(2, "0")}-${String(co.getDate()).padStart(2, "0")}`;
    const names = ["週日","週一","週二","週三","週四","週五","週六"];
    dayOfWeek = names[ci.getDay()];
    isWeekend = ci.getDay() === 5 || ci.getDay() === 6; // 五、六入住算週末
  }
  const now = new Date();
  const scrapeDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return {
    schemaVersion: 1,
    lastUpdated: now.toISOString(),
    scrapeDate,            // 抓這份的日期（給歷史趨勢用 x 軸）
    checkin, checkout, dayOfWeek, isWeekend,
    source: "beautyhotel-sync extension push",
    hotels,
  };
}

// ---- GitHub API：建立/更新一個檔案 ----
function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
// 讀某路徑現有 JSON 內容 + sha（不存在回 {json:null}）
async function ghGetJson(path, cfg) {
  const base = `https://api.github.com/repos/${cfg.repo}/contents/${path}`;
  const headers = { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json" };
  const res = await fetch(`${base}?ref=${encodeURIComponent(cfg.branch)}`, { headers });
  if (res.status === 404) return { json: null, sha: undefined };
  if (!res.ok) throw new Error(`讀取 ${path} 失敗：${res.status}`);
  const j = await res.json();
  let json = null;
  try { json = JSON.parse(decodeURIComponent(escape(atob(j.content)))); } catch (e) {}
  return { json, sha: j.sha };
}
async function ghPut(path, obj, message, cfg, sha) {
  const base = `https://api.github.com/repos/${cfg.repo}/contents/${path}`;
  const headers = { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" };
  if (sha === undefined) {
    // 沒傳就自己查一次
    const cur = await ghGetJson(path, cfg);
    sha = cur.sha;
  }
  const body = { message, content: utf8ToBase64(JSON.stringify(obj, null, 2)), branch: cfg.branch };
  if (sha) body.sha = sha;
  const putRes = await fetch(base, { method: "PUT", headers, body: JSON.stringify(body) });
  if (!putRes.ok) {
    const txt = await putRes.text();
    throw new Error(`寫入 ${path} 失敗：${putRes.status} ${txt.slice(0, 120)}`);
  }
  return putRes.json();
}

// ---- 推送 ----
async function doPush() {
  const st = $("pushStatus");
  const cfg = await getCfg();
  if (!cfg.token) {
    setStatus(st, "❌ 還沒設定 GitHub Token，請展開下方「⚙️ GitHub 推送設定」", "err");
    $("settings").open = true;
    return;
  }
  cfg.repo = cfg.repo || "hotelbchic/beautyhotel";
  cfg.branch = cfg.branch || "main";

  const checkin = $("pushDate").value;
  if (!checkin) { setStatus(st, "❌ 沒有可發布的日期", "err"); return; }

  $("push").disabled = true;
  setStatus(st, "⏳ 正在推送 latest.json …", "info");
  try {
    const snap = await buildSnapshot(checkin);
    const sd = snap.scrapeDate;
    await ghPut("data/latest.json", snap, `data: 更新 ${checkin} 房價 (extension)`, cfg);

    setStatus(st, "⏳ latest.json 完成，寫入歷史快照 …", "info");
    // 歷史檔以「抓取日期」命名：每天一份，記錄「那天看到的價」→ 可看 pickup 趨勢
    await ghPut(`data/history/${sd}.json`, snap, `data: 歷史快照 ${sd} (extension)`, cfg);

    // 維護 history/index.json（檔案清單，給比價表的歷史趨勢分頁讀）
    const idx = await ghGetJson("data/history/index.json", cfg);
    const list = Array.isArray(idx.json) ? idx.json : [];
    if (!list.includes(sd)) list.push(sd);
    list.sort();
    await ghPut("data/history/index.json", list, `data: 更新歷史索引 (${sd})`, cfg, idx.sha);

    setStatus(st, `✅ 推送成功！<br>GitHub Pages 約 30-60 秒後更新，手機開比價表即可看到 ${checkin} 的房價。`, "ok");
  } catch (e) {
    setStatus(st, `❌ ${e.message || e}`, "err");
  } finally {
    $("push").disabled = false;
  }
}

// ---- 設定存讀 ----
async function loadCfgToForm() {
  const cfg = await getCfg();
  if (cfg.token) $("ghToken").value = cfg.token;
  $("ghRepo").value = cfg.repo || "hotelbchic/beautyhotel";
  $("ghBranch").value = cfg.branch || "main";
}
function saveCfg() {
  const cfg = {
    token: $("ghToken").value.trim(),
    repo: $("ghRepo").value.trim() || "hotelbchic/beautyhotel",
    branch: $("ghBranch").value.trim() || "main",
  };
  chrome.storage.local.set({ [CFG_KEY]: cfg }, () => {
    setStatus($("cfgStatus"), "✅ 已儲存", "ok");
    setTimeout(() => clearStatus($("cfgStatus")), 2500);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  $("open-bh").onclick = () => chrome.tabs.create({ url: "https://hotelbchic.github.io/beautyhotel/" });
  $("open-gt").onclick = () => chrome.tabs.create({ url: "https://www.google.com/travel/hotels?hl=zh-TW&gl=tw" });
  $("clear").onclick = () => {
    if (!confirm("確定要清空所有抓取的房價資料？")) return;
    chrome.storage.local.set({ bhScrapes: [] }, render);
  };
  $("push").onclick = doPush;
  $("saveCfg").onclick = saveCfg;
  loadCfgToForm();
  render();
});
