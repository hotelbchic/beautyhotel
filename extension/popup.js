document.addEventListener("DOMContentLoaded", () => {
  const countEl = document.getElementById("count");
  const listEl = document.getElementById("list");

  function render() {
    chrome.storage.local.get(["bhScrapes"], (r) => {
      const arr = r.bhScrapes || [];
      countEl.textContent = arr.length;
      if (arr.length === 0) {
        listEl.innerHTML = `<div class="empty">尚未抓取任何資料</div>`;
        return;
      }
      // sort by ts desc, top 20
      const sorted = [...arr].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 20);
      listEl.innerHTML = sorted
        .map((e) => {
          const min = Math.min(...Object.values(e.prices));
          return `<div class="row">
            <div>
              <div class="name">${e.hotelId}</div>
              <div class="date">${e.checkin}</div>
            </div>
            <div style="text-align:right;font-weight:700;">$${min}</div>
          </div>`;
        })
        .join("");
    });
  }

  document.getElementById("open-bh").onclick = () => {
    chrome.tabs.create({ url: "https://hotelbchic.github.io/beautyhotel/" });
  };
  document.getElementById("open-gt").onclick = () => {
    chrome.tabs.create({ url: "https://www.google.com/travel/hotels?hl=zh-TW&gl=tw" });
  };
  document.getElementById("clear").onclick = () => {
    if (!confirm("確定要清空所有抓取的房價資料？")) return;
    chrome.storage.local.set({ bhScrapes: [] }, render);
  };

  render();
});
