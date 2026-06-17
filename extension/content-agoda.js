/* eslint-disable */
// 在 Agoda 飯店頁(agoda.com/zh-tw/<slug>/hotel/...)抓「該日最低房價」，給背景引擎當 Google 漏抓時的備援。
// 只回應背景的 extractAgoda 訊息，不主動做事（低調，降低被 Agoda 反爬注意）。
(function () {
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
          const p = extractAgodaPrice();
          if (p) { sendResponse({ price: p }); return; }
          await new Promise((r) => setTimeout(r, 800));
        }
        sendResponse({ price: null });
      })();
      return true;
    }
  });
})();
