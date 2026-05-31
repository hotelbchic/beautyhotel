/* eslint-disable */
// 在 hotelbchic.github.io/beautyhotel 頁面右下角加「📥 從擴充匯入」按鈕
// 點下去：讀 chrome.storage.bhScrapes，寫到頁面的 localStorage `bh_prices_v1`，重新整理

(function () {
  function buildUI() {
    if (document.getElementById("bh-import-root")) return;
    const root = document.createElement("div");
    root.id = "bh-import-root";
    root.innerHTML = `
      <button id="bh-import-btn" type="button">
        <span>📥 從擴充匯入</span>
        <span class="bh-counter" id="bh-import-count">0</span>
      </button>
      <div id="bh-import-toast"></div>
    `;
    document.body.appendChild(root);

    const btn = root.querySelector("#bh-import-btn");
    const toast = root.querySelector("#bh-import-toast");
    const counter = root.querySelector("#bh-import-count");

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
