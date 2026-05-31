/* eslint-disable */
// 在 Google Travel 頁面右下角加一顆「📥 抓房價」按鈕
// 點下去：自動抓當前 hotel + 當前查詢日期 + 3 OTA 房價，存到 chrome.storage

(function () {
  const HOTEL_KEYWORDS = [
    ["own",     ["峻美", "Bnight"]],
    ["bchic",   ["昇美", "Bchic"]],
    ["qiancai", ["千彩格", "Colors Inn"]],
    ["roumei",  ["柔美"]],
    ["shemei",  ["碩美", "Bstay"]],
    ["zhenmei", ["甄美"]],
    ["tianjin", ["天津", "Vagus"]],
    ["yunfu",   ["雲富", "Hotel Cloud", "YUN FU"]],
    ["apt35",   ["35號公寓", "35apt", "N.APT"]],
    ["bstay",   ["中山北棧"]],
  ];

  function detectHotelId(title) {
    const t = (title || "").toLowerCase();
    for (const [id, kws] of HOTEL_KEYWORDS) {
      if (kws.some((k) => t.includes(k.toLowerCase()))) return id;
    }
    return null;
  }

  function extractCurrent() {
    // 飯店名: 從 <h2> 或頁面 title
    const h = document.querySelector("h2, [role='heading'][aria-level='1']");
    const hotelName = (h && h.innerText.split("\n")[0]) || document.title.split(" - ")[0];

    // 日期: 從畫面上的 M月D日 文字抓
    const txt = document.body.innerText;
    const dateMatches = txt.match(/(\d+)月(\d+)日週./g) || [];
    const dates = dateMatches.slice(0, 2).map((d) => {
      const m = d.match(/(\d+)月(\d+)日/);
      return m ? `${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
    }).filter(Boolean);

    // OTA 價格: 找「造訪網站」按鈕對應 row
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

    const hotelId = detectHotelId(hotelName);
    return { hotelId, hotelName, dates, prices };
  }

  function buildUI() {
    if (document.getElementById("bh-grab-root")) return;
    const root = document.createElement("div");
    root.id = "bh-grab-root";
    root.innerHTML = `
      <button id="bh-grab-btn" type="button">
        <span>📥 抓房價</span>
        <span class="bh-counter" id="bh-grab-count">0</span>
      </button>
      <div id="bh-grab-toast"></div>
    `;
    document.body.appendChild(root);

    const btn = root.querySelector("#bh-grab-btn");
    const toast = root.querySelector("#bh-grab-toast");
    const counter = root.querySelector("#bh-grab-count");

    chrome.storage.local.get(["bhScrapes"], (r) => {
      const arr = r.bhScrapes || [];
      counter.textContent = arr.length;
    });

    function showToast(html) {
      toast.innerHTML = html;
      toast.classList.add("show");
      clearTimeout(toast._t);
      toast._t = setTimeout(() => toast.classList.remove("show"), 6000);
    }

    btn.addEventListener("click", () => {
      const d = extractCurrent();
      if (!d.hotelId) {
        showToast(`❌ 認不出這是哪間飯店<br><small>${(d.hotelName || "").slice(0, 40)}</small>`);
        return;
      }
      if (!d.dates.length || Object.keys(d.prices).length === 0) {
        showToast(`❌ 抓不到日期或價格，請確認頁面已載入完整 OTA 列表`);
        return;
      }
      chrome.storage.local.get(["bhScrapes"], (r) => {
        const arr = r.bhScrapes || [];
        const entry = {
          hotelId: d.hotelId,
          hotelName: d.hotelName,
          checkin: d.dates[0],
          checkout: d.dates[1] || null,
          prices: d.prices,
          ts: Date.now(),
        };
        // 同 hotel + 同 checkin 視為更新而非新增
        const key = (e) => e.hotelId + "@" + e.checkin;
        const filtered = arr.filter((e) => key(e) !== key(entry));
        filtered.push(entry);
        chrome.storage.local.set({ bhScrapes: filtered }, () => {
          counter.textContent = filtered.length;
          const ota = Object.entries(d.prices)
            .map(([k, v]) => `${k} <b>$${v}</b>`)
            .join(" · ");
          showToast(
            `✅ 已存 <b>${d.hotelId}</b> @${d.checkin}<br>${ota}<br><small>累計 ${filtered.length} 筆，到 beautyhotel 頁面按「📥 匯入」</small>`
          );
        });
      });
    });
  }

  // Google Travel 是 SPA, URL 變但頁面不重新載
  buildUI();
  setInterval(buildUI, 2000);
})();
