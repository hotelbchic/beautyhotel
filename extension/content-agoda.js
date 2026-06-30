/* eslint-disable */
// 在 Agoda 飯店頁(agoda.com/zh-tw/<slug>/hotel/...)抓「該日最低房價」，給背景引擎當 Google 漏抓時的備援。
// 只回應背景的 extractAgoda 訊息，不主動做事（低調，降低被 Agoda 反爬注意）。
(function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 這天「不能訂單晚」的訊號：最低住宿天數限制 / 客滿售完 → 回 null(讓格子留空，不要亂填數字)
  function isBlocked() {
    const t = document.body.innerText || "";
    const minStay =
      /連續入住\s*\d+\s*晚|最[少低][^。\n]{0,6}入住[^。\n]{0,6}\d+\s*晚|最[少低]住宿[^。\n]{0,6}\d+\s*晚|需(要)?入住\s*\d+\s*晚|入住\s*\d+\s*晚以上|\d+\s*晚以上(才|方)|minimum\s+stay|\d+[\s-]*night\s+minimum/i;
    const soldOut =
      /此日期[^。\n]{0,8}(客滿|售完|售罄|無空房|沒有空房|已訂滿)|查無[^。\n]{0,6}房|目前無可訂房|no\s+rooms?\s+available|sold\s*out|fully\s*booked/i;
    return minStay.test(t) || soldOut.test(t);
  }

  function extractAgodaPrice() {
    const t = document.body.innerText || "";
    // 抓所有 NT$ 數字，取「房價合理範圍」內最先出現的(= 頁面主打價)
    const matches = t.match(/NT\$\s*([\d,]{3,})/g) || [];
    for (const s of matches) {
      const v = parseInt(s.replace(/[^\d]/g, ""), 10);
      if (v >= 400 && v <= 30000) return v;
    }
    return null;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "extractAgoda") {
      (async () => {
        const start = Date.now();
        while (Date.now() - start < 16000) { // 等價格載入(Agoda 較慢)
          await sleep(800);
          // 頁面載一下下後再判斷，避免抓到還沒渲染完的暫態文字
          if (Date.now() - start > 3500 && isBlocked()) { sendResponse({ price: null }); return; }
          const p = extractAgodaPrice();
          if (p) {
            // 抓到價，但若同時有「限制續住/客滿」訊號，視為這天不可單訂 → 留空
            if (isBlocked()) { sendResponse({ price: null }); return; }
            sendResponse({ price: p });
            return;
          }
        }
        sendResponse({ price: null });
      })();
      return true;
    }
  });
})();
