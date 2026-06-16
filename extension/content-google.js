/* eslint-disable */
// 在 Google Travel 頁面右下角加按鈕：
//  - 📥 抓這間：抓當前開啟的飯店詳細頁 3 OTA 房價
//  - 📥📥 批次抓全部：在區域搜尋結果頁，自動逐間點開、抓價、換下一間
// 抓到的資料存進 chrome.storage，之後到比價表頁面匯入。

(function () {
  // 順序很重要：先檢查最具體的字串
  // 注意 apt35 與 napt 兩間都屬於 N.APT 品牌，必須用「中山」/「35」前綴去區分
  const HOTEL_KEYWORDS = [
    ["own",     ["峻美", "Bnight"]],
    ["bchic",   ["昇美", "Bchic"]],
    ["qiancai", ["千彩格", "Colors Inn"]],
    ["roumei",  ["柔美"]],
    ["shemei",  ["碩美", "Bstay"]],
    ["zhenmei", ["甄美"]],
    ["tianjin", ["天津", "Vagus"]],
    ["yunfu",   ["雲富", "Hotel Cloud", "YUN FU"]],
    ["napt",   ["中山N.APT", "中山 N.APT", "中山北棧"]], // 中山北棧 (Google 叫「中山N.APT」)
    ["apt35",   ["35apt", "35號公寓", "35號 N.APT", "N.APT 35"]], // 35號公寓
  ];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function detectHotelId(title) {
    const t = (title || "").toLowerCase();
    for (const [id, kws] of HOTEL_KEYWORDS) {
      if (kws.some((k) => t.includes(k.toLowerCase()))) return id;
    }
    return null;
  }

  const toMMDD = (mo, da) => `${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}`;

  // 抓 checkin / checkout → ["MM-DD","MM-DD"]
  // 重點：Google Travel 的日期在「日期選擇器 input 的 value」裡（例如「6月27日週六」），
  // 而 input.value 不會出現在 document.body.innerText，所以一定要讀 input。
  function extractDates() {
    const found = [];
    document.querySelectorAll("input").forEach((i) => {
      const m = (i.value || "").match(/(\d+)月(\d+)日/);
      if (m) found.push(toMMDD(m[1], m[2]));
    });
    // 去重但保留順序（picker 常有重複 input），取前兩個 = checkin/checkout
    const uniq = [...new Set(found)];
    if (uniq.length >= 2) return uniq.slice(0, 2);
    if (uniq.length === 1) return uniq;
    // 後備：從日期按鈕 aria-label「6月27日至28日…」抓
    const lbl = [...document.querySelectorAll("[aria-label]")]
      .map((e) => e.getAttribute("aria-label") || "")
      .find((l) => /\d+月\d+日至\d+日/.test(l));
    if (lbl) {
      const m = lbl.match(/(\d+)月(\d+)日至(\d+)日/);
      if (m) return [toMMDD(m[1], m[2]), toMMDD(m[1], m[3])];
    }
    return [];
  }

  // 抓「目前詳細面板」的 3 OTA 價格
  function extractPrices() {
    const buttons = Array.from(document.querySelectorAll("a, button")).filter((b) =>
      (b.innerText || "").includes("造訪網站")
    );
    const prices = {};
    buttons.forEach((btn) => {
      let row = btn;
      for (let i = 0; i < 6 && row; i++) {
        row = row.parentElement;
        if (!row) break;
        const t = row.innerText || "";
        if (t.length > 400) continue;
        const pm = t.match(/\$([\d,]+)/);
        if (!pm) continue;
        const om = t.match(/(Booking\.com|Agoda|Trip\.com|Hotels\.com|Expedia|Skyscanner|tw\.KAYAK\.com|KAYAK)/);
        if (!om) continue;
        const k = om[1].replace("tw.", "").replace(".com", "").toLowerCase();
        const v = parseInt(pm[1].replace(/,/g, ""));
        if (!prices[k] || v < prices[k]) prices[k] = v;
        break;
      }
    });
    return prices;
  }

  function currentHotelName() {
    // Google Travel 詳細頁的 document.title 就是「開啟中的飯店名」，最可靠。
    // （頁面上第一個 h2 往往是左側清單/廣告，會抓錯，例如「臺北車站智選假日酒店」）
    const t = (document.title || "").replace(/\s*[-–]\s*Google.*$/, "").trim();
    if (t && !/搜尋|住宿資訊|Google|飯店搜尋/.test(t)) return t;
    // 還在搜尋列表頁（title 是「搜尋…的住宿資訊」）→ 回傳空，交給呼叫端判斷
    const h = document.querySelector("[role='heading'][aria-level='1']");
    return (h && h.innerText.split("\n")[0]) || "";
  }

  function extractCurrent() {
    const hotelName = currentHotelName();
    return {
      hotelId: detectHotelId(hotelName),
      hotelName,
      dates: extractDates(),
      prices: extractPrices(),
    };
  }

  // 存一筆（同 hotel + 同 checkin 視為更新）
  function storeEntry(d) {
    return new Promise((resolve) => {
      chrome.storage.local.get(["bhScrapes"], (r) => {
        const arr = r.bhScrapes || [];
        const entry = {
          hotelId: d.hotelId,
          hotelName: d.hotelName,
          checkin: d.dates[0] || null,
          checkout: d.dates[1] || null,
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

  // ---- 批次模式 ----

  // 找左側清單裡屬於我們 comp set 的飯店卡片（用 aria-label 抓最穩）
  function findSidebarCards() {
    const cards = [];
    const seen = new Set();
    const links = document.querySelectorAll("a[aria-label]");
    links.forEach((a) => {
      const label = a.getAttribute("aria-label") || "";
      if (!label.includes("價格") && !label.includes("$")) return;
      const id = detectHotelId(label);
      if (id && !seen.has(id)) {
        seen.add(id);
        cards.push({ id, el: a, label });
      }
    });
    return cards;
  }

  // 點開某卡片後等價格載入；會自動處理「載入結果時發生問題 → 再試一次」
  async function waitForPrices(expectedId, timeout) {
    const start = Date.now();
    let retried = 0;
    while (Date.now() - start < timeout) {
      // 載入失敗 → 點再試一次（最多 2 次）
      const retryBtn = Array.from(document.querySelectorAll("button, a")).find((b) =>
        (b.innerText || "").trim() === "再試一次"
      );
      if (retryBtn && retried < 2) {
        retryBtn.click();
        retried++;
        await sleep(2500);
        continue;
      }
      const d = extractCurrent();
      // 必須是「面板已切到正確飯店」且抓到價，才算成功
      if (d.hotelId === expectedId && Object.keys(d.prices).length > 0) return d;
      await sleep(500);
    }
    return null;
  }

  async function batchGrab(toast, counter, btn) {
    const cards = findSidebarCards();
    if (cards.length === 0) {
      showToast(toast, `⚠️ 這頁找不到 comp set 飯店<br><small>請先在 Google Travel 搜尋「台北中山區飯店」或「Beauty Hotels Taipei」這類區域查詢</small>`);
      return;
    }
    btn.classList.add("busy");
    const ok = [], skip = [];
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      showToast(toast, `⏳ (${i + 1}/${cards.length}) 點開 <b>${c.id}</b>…`, true);
      try {
        c.el.scrollIntoView({ block: "center" });
        c.el.click();
      } catch (e) {}
      const d = await waitForPrices(c.id, 12000);
      if (d) {
        const n = await storeEntry(d);
        counter.textContent = n;
        ok.push(c.id);
        const ota = Object.entries(d.prices).map(([k, v]) => `${k} $${v}`).join(" · ");
        showToast(toast, `✅ (${i + 1}/${cards.length}) <b>${c.id}</b> @${d.dates[0] || "?"}<br>${ota}`, true);
      } else {
        skip.push(c.id);
        showToast(toast, `⚠️ (${i + 1}/${cards.length}) <b>${c.id}</b> 載入逾時，跳過`, true);
      }
      await sleep(800); // 對 Google 友善一點，降低被擋機率
    }
    btn.classList.remove("busy");
    showToast(
      toast,
      `🎉 批次完成<br>成功 <b>${ok.length}</b> 間${skip.length ? `，跳過 ${skip.length} 間 (${skip.join(", ")})` : ""}<br><small>到比價表頁面按「📥 從擴充匯入」</small>`
    );
  }

  // ---- UI ----

  function showToast(toast, html, sticky) {
    toast.innerHTML = html;
    toast.classList.add("show");
    clearTimeout(toast._t);
    if (!sticky) toast._t = setTimeout(() => toast.classList.remove("show"), 6000);
  }

  function buildUI() {
    if (document.getElementById("bh-grab-root")) return;
    const root = document.createElement("div");
    root.id = "bh-grab-root";
    root.innerHTML = `
      <button id="bh-batch-btn" type="button" class="bh-secondary">
        <span>📥📥 批次抓全部</span>
      </button>
      <button id="bh-grab-btn" type="button">
        <span>📥 抓這間</span>
        <span class="bh-counter" id="bh-grab-count">0</span>
      </button>
      <div id="bh-grab-toast"></div>
    `;
    document.body.appendChild(root);

    const btn = root.querySelector("#bh-grab-btn");
    const batchBtn = root.querySelector("#bh-batch-btn");
    const toast = root.querySelector("#bh-grab-toast");
    const counter = root.querySelector("#bh-grab-count");

    chrome.storage.local.get(["bhScrapes"], (r) => {
      counter.textContent = (r.bhScrapes || []).length;
    });

    // 單間
    btn.addEventListener("click", async () => {
      const d = extractCurrent();
      if (!d.hotelId) {
        showToast(toast, `❌ 認不出這是哪間飯店<br><small>${(d.hotelName || "").slice(0, 40)}</small>`);
        return;
      }
      if (!d.dates.length || Object.keys(d.prices).length === 0) {
        showToast(toast, `❌ 抓不到日期或價格，請確認頁面已載入完整 OTA 列表`);
        return;
      }
      const n = await storeEntry(d);
      counter.textContent = n;
      const ota = Object.entries(d.prices).map(([k, v]) => `${k} <b>$${v}</b>`).join(" · ");
      showToast(toast, `✅ 已存 <b>${d.hotelId}</b> @${d.dates[0]}<br>${ota}<br><small>累計 ${n} 筆</small>`);
    });

    // 批次
    batchBtn.addEventListener("click", () => batchGrab(toast, counter, batchBtn));
  }

  // ---- 自動把日期設成今天 (auto-batch 開頭呼叫一次，之後同 session 會沿用) ----
  function clickDayCell(date) {
    const target = `${date.getMonth() + 1}月${date.getDate()}日`;
    const cands = document.querySelectorAll('[role="gridcell"], [aria-label]');
    for (const c of cands) {
      const lbl = c.getAttribute("aria-label") || "";
      if (lbl.includes(target) && !/已停用|disabled/i.test(lbl)) {
        const btn = c.querySelector('[role="button"], button, div[jsaction]') || c;
        btn.click();
        return true;
      }
    }
    return false;
  }
  async function setDatesToToday() {
    const today = new Date();
    const tomorrow = new Date(today.getTime() + 86400000);
    // 點開入住日期選擇器
    const opener =
      [...document.querySelectorAll("[aria-label]")].find((e) =>
        /登機報到頁面|入住|報到/.test(e.getAttribute("aria-label") || "")
      ) || [...document.querySelectorAll("input")].find((i) => /\d+月\d+日/.test(i.value || ""));
    if (!opener) return { ok: false, reason: "找不到日期欄" };
    opener.click();
    await sleep(1000);
    const ok1 = clickDayCell(today);
    await sleep(600);
    const ok2 = clickDayCell(tomorrow);
    await sleep(600);
    // 按「完成」
    const done = [...document.querySelectorAll("button, [role='button']")].find((b) =>
      /完成|套用|done|apply/i.test((b.innerText || "") + " " + (b.getAttribute("aria-label") || ""))
    );
    if (done) done.click();
    await sleep(1800);
    return { ok: ok1 && ok2, dates: extractDates() };
  }

  // 背景引擎(background.js)叫我抓價：等價格載入(含「再試一次」)後回傳結果
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "extractNow") {
      (async () => {
        const d = await waitForPrices(msg.expectedId, 18000);
        sendResponse(d || null);
      })();
      return true; // 非同步回覆，保持通道
    }
    if (msg && msg.type === "setDateToday") {
      (async () => sendResponse(await setDatesToToday()))();
      return true;
    }
  });

  // Google Travel 是 SPA, URL 變但頁面不重新載
  buildUI();
  setInterval(buildUI, 2000);
})();
