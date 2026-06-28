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
      <div id="bh-range-panel" style="background:#1a1a2e;border:1px solid rgba(255,255,255,.2);border-radius:12px;padding:10px 12px;margin-bottom:8px;color:#fff;font-size:12px;">
        <div style="font-weight:700;margin-bottom:6px;">📅 抓日期區間 → 更新「14天日曆」（最多 14 天）</div>
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">
          <input type="date" id="bh-range-start" style="flex:1;border-radius:6px;border:none;padding:4px;font-size:12px;">
          <span>→</span>
          <input type="date" id="bh-range-end" style="flex:1;border-radius:6px;border:none;padding:4px;font-size:12px;">
        </div>
        <div id="bh-range-hint" style="font-size:11px;color:rgba(255,255,255,.55);margin-bottom:6px;">選好區間（每天都抓真實價）</div>
        <button id="bh-range-btn" type="button" style="width:100%;background:linear-gradient(135deg,#2980b9,#3498db);border:none;border-radius:8px;color:#fff;padding:8px;font-weight:700;cursor:pointer;font-family:inherit;">📅 抓這區間（更新日曆）</button>
      </div>
      <div id="bh-import-toast"></div>
    `;
    document.body.appendChild(root);

    const autoBtn = root.querySelector("#bh-auto-btn");
    const toast = root.querySelector("#bh-import-toast");

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

    // 日期區間抓（最多 14 天，每天都抓真實價）
    const startInp = root.querySelector("#bh-range-start");
    const endInp = root.querySelector("#bh-range-end");
    const rangeBtn = root.querySelector("#bh-range-btn");
    const rangeHint = root.querySelector("#bh-range-hint");
    const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const _today = new Date();
    const _wk = new Date(_today.getTime() + 6 * 86400000);
    if (startInp) { startInp.value = isoOf(_today); startInp.min = isoOf(_today); }
    if (endInp) { endInp.value = isoOf(_wk); endInp.min = isoOf(_today); }
    function rangeDays() {
      if (!startInp.value || !endInp.value) return null;
      const s = new Date(startInp.value + "T00:00:00"), e = new Date(endInp.value + "T00:00:00");
      const n = Math.round((e - s) / 86400000) + 1;
      return n;
    }
    function refreshHint() {
      const n = rangeDays();
      if (n === null) { rangeHint.textContent = "請選開始與結束日期"; rangeHint.style.color = "#ff9bb0"; return false; }
      if (n < 1) { rangeHint.textContent = "結束日不能早於開始日"; rangeHint.style.color = "#ff9bb0"; return false; }
      if (n > 14) { rangeHint.textContent = `${n} 天太多，最多 14 天`; rangeHint.style.color = "#ff9bb0"; return false; }
      rangeHint.textContent = `共 ${n} 天 × 10 間 ≈ ${n * 10} 次查詢，約 ${Math.ceil(n * 10 * 8 / 60)} 分鐘`;
      rangeHint.style.color = "rgba(255,255,255,.55)";
      return true;
    }
    if (startInp) startInp.addEventListener("change", refreshHint);
    if (endInp) endInp.addEventListener("change", refreshHint);
    refreshHint();
    if (rangeBtn) rangeBtn.addEventListener("click", () => {
      if (!refreshHint()) { showToast("⚠️ " + rangeHint.textContent); return; }
      chrome.runtime.sendMessage({ type: "startRangeScan", startISO: startInp.value, endISO: endInp.value }, (resp) => {
        if (resp && resp.started) showToast(`⏳ 開始抓 ${startInp.value} ~ ${endInp.value}（彈出新視窗自動跑），跑完自動關閉、本頁更新`);
        else showToast("⚠️ 已經在跑了");
      });
      pollAuto();
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
            // 不要固定秒數重整(GitHub Pages 更新要 30-60 秒)，改成「輪詢到新資料真的上線才重整」
            if (!s.error) waitFreshThenReload();
          }
        });
      }, 1000);
    }

    // 輪詢 GitHub 的 latest.json，等版本號比目前頁面新(=新資料已上線)才重整；最多等 ~100 秒
    function waitFreshThenReload() {
      let appliedVer = 0;
      try { appliedVer = (JSON.parse(localStorage.getItem("bh_prices_v1")) || {}).ver || 0; } catch (e) {}
      let tries = 0;
      showToast("⏳ 等 GitHub 更新(約 30-60 秒)，好了自動重整顯示新價…");
      const t = setInterval(() => {
        tries++;
        fetch("data/latest.json?t=" + Date.now(), { cache: "no-store" })
          .then((r) => r.json())
          .then((d) => {
            const ver = typeof d.version === "number" ? d.version : (d.lastUpdated ? new Date(d.lastUpdated).getTime() : 0);
            if (ver > appliedVer || tries >= 13) { clearInterval(t); location.reload(); }
          })
          .catch(() => { if (tries >= 13) { clearInterval(t); location.reload(); } });
      }, 8000);
    }

    function showToast(html) {
      toast.innerHTML = html;
      toast.classList.add("show");
      clearTimeout(toast._t);
      toast._t = setTimeout(() => toast.classList.remove("show"), 8000);
    }

  }

  buildUI();
  setInterval(buildUI, 2000);
})();
