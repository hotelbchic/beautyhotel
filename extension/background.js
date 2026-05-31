// 占位 service worker — 目前所有邏輯都在 content scripts
// 之後若要做自動排程或批次開分頁，可在這裡加。
chrome.runtime.onInstalled.addListener(() => {
  console.log("beautyhotel-sync installed");
});
