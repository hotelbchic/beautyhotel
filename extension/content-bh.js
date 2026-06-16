/* eslint-disable */
// 在 hotelbchic.github.io/beautyhotel 頁面右下角加「📥 從擴充匯入」按鈕
// 點下去：讀 chrome.storage.bhScrapes，寫到頁面的 localStorage `bh_prices_v1`，重新整理

(function () {
  function buildUI() {
    if (document.getElementById("bh-import-root")) return;
    const root = document.createElement("div");
    root.id = "bh-import-root";
    root.innerHTML = `
      <button id="bh-auto-btn" type="button" style="background:linear-gradient(135deg,#27ae60,#2ecc71);margin-bottom:8px;">
        <span>⚡ 一鍵全抓 10 間 + 更新</span>
      </button>
      <button id="bh-sample-btn" type="button" style="background:linear-gradient(135deg,#2980b9,#3498db);margin-bottom:8px;">
        <span>📅 抓 30 天取樣（約 10 分）</span>
      </button>
      <button id="bh-import-btn" type="button">
        <span>📥 從擴充匯入</span>
        <span class="bh-counter" id="bh-import-count">0</span>
      </button>
      <div id="bh-import-toast"></div>
    `;
    document.body.appendChild(root);

    const btn = root.querySelector("#bh-import-btn");
    const autoBtn = root.querySelector("#bh-auto-btn");
    const toast = root.querySelector("#bh-import-toast");
    const counter = root.querySelector("#bh-import-count");

    // 一鍵全抓：叫背景引擎自動跑 10 間 + 推 GitHub；跑完自動重整本頁看新價
    // 注意：不用 confirm()（原生對話框會擋住遠端自動化），改成直接跑 + toast 提示
    function triggerAuto() {
      chrome.runtime.sendMessage({ type: "startAutoBatch" }, (resp) => {
        if (resp && resp.started) showToast("⏳ 已開始！會自動彈出一個新視窗抓今天 10 間（約 1.5-2 分鐘），跑完自動關閉視窗、本頁自動更新。");
        else showToast("⚠️ 已經在跑了");
      });
      pollAuto();
    }
    autoBtn.addEventListener("click", triggerAuto);

    // 30 天取樣
    const sampleBtn = root.querySelector("#bh-sample-btn");
    if (sampleBtn) sampleBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "startSampleScan" }, (resp) => {
        if (resp && resp.started) showToast("⏳ 30 天取樣已開始（會彈出新視窗，約 10 分鐘抓 10 代表日×10 間）…跑完自動關閉視窗、本頁自動更新");
        else showToast("⚠️ 已經在跑了");
      });
      pollAuto();
    });

    // 把頁面右上角原本的「🔄 即時比價」按鈕也接上一鍵全抓（裝了擴充才有此行為）
    document.querySelectorAll(".header-tag").forEach((t) => {
      if (t.textContent.includes("即時比價") && !t.dataset.bhHijacked) {
        t.dataset.bhHijacked = "1";
        t.setAttribute("title", "一鍵全抓 10 間 + 推送更新（擴充）");
        t.addEventListener("click", (e) => { e.stopImmediatePropagation(); e.preventDefault(); triggerAuto(); }, true);
      }
    });
    let pollTimer = null;
    function pollAuto() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(() => {
        chrome.storage.local.get(["bhAutoStatus"], (r) => {
          const s = r.bhAutoStatus;
          if (!s) return;
          showToast(`${s.running ? `⏳ (${s.i}/${s.total}) ` : ""}${s.msg || ""}`);
          if (s.done) {
            clearInterval(pollTimer); pollTimer = null;
            // 推送完隔幾秒，等 GitHub Pages 更新後重整本頁
            if (!s.error) setTimeout(() => location.reload(), 6000);
          }
        });
      }, 1000);
    }

    function showToast(html) {
      toast.innerHTML = html;
      toast.classList.add("show");
      clearTimeout(toast._t);
      toast._t = setTimeout(() => toast.classList.remove("show"), 8000);
    }

    function refreshCount() {
      chrome.storage.local.get(["bhScrapes"], (r) => {
        counter.textContent = (r.bhScrapes || []).length;
      });
    }
    refreshCount();

    btn.addEventListener("click", () => {
      chrome.storage.local.get(["bhScrapes"], (r) => {
        const scrapes = r.bhScrapes || [];
        if (scrapes.length === 0) {
          showToast(`沒有資料可匯入<br><small>先到 Google Travel 點「📥 抓房價」</small>`);
          return;
        }

        // 把抓到的資料合併到 localStorage bh_prices_v1
        // 格式: {today:{hotelId:{agoda,trip,booking}}, priceData:{hotelId:[30 days]}}
        const stored = JSON.parse(localStorage.getItem("bh_prices_v1") || "{}");
        const today = stored.today || {};
        const priceData = stored.priceData || {};

        // 算今天的日期 string (M-D, 2 digits each)
        const now = new Date();
        const todayStr = String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");

        // 30 天的對應 index
        function dayIndex(checkin) {
          // checkin = "07-08"
          const [m, d] = checkin.split("-").map((x) => parseInt(x));
          const checkinDate = new Date(now.getFullYear(), m - 1, d);
          // 跨年: 如果 checkin 月份比今天小很多, 視為明年
          if (m < now.getMonth() + 1 - 6) {
            checkinDate.setFullYear(now.getFullYear() + 1);
          }
          const diff = Math.round((checkinDate - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
          return diff;
        }

        let todayUpdated = 0;
        let dayUpdated = 0;
        scrapes.forEach((s) => {
          const min = Math.min(...Object.values(s.prices));
          // 今日比價: 只有當 checkin 就是今天或明天才覆蓋 today object
          if (s.checkin === todayStr) {
            today[s.hotelId] = {
              agoda: s.prices.agoda || null,
              trip: s.prices.trip || null,
              booking: s.prices.booking || null,
            };
            todayUpdated++;
          }
          // 30 天日曆: 找對應 dayIndex 寫入最低價
          const idx = dayIndex(s.checkin);
          if (idx >= 0 && idx < 30) {
            if (!priceData[s.hotelId]) priceData[s.hotelId] = new Array(30).fill(null);
            priceData[s.hotelId][idx] = min;
            dayUpdated++;
          }
        });

        const newStored = { today, priceData, ts: Date.now() };
        localStorage.setItem("bh_prices_v1", JSON.stringify(newStored));

        showToast(
          `✅ 已匯入 ${scrapes.length} 筆<br>` +
            `今日比價更新 <b>${todayUpdated}</b> 間<br>` +
            `30 天日曆寫入 <b>${dayUpdated}</b> 點<br>` +
            `<small>頁面將重新載入以套用</small>`
        );
        setTimeout(() => location.reload(), 1500);
      });
    });
  }

  buildUI();
  setInterval(buildUI, 2000);
})();
