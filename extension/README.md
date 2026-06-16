# beautyhotel 房價同步 Chrome 擴充

把 Google Travel 上看到的飯店 3 OTA 房價，一鍵抓取並推送到 hotelbchic.github.io/beautyhotel 比價表，手機/桌面都能看到，全程 0 訂閱費。

## 安裝
1. Chrome 開啟 `chrome://extensions/`
2. 右上角開啟「開發人員模式」
3. 點「載入未封裝項目」→ 選這個 `extension` 資料夾
4. 完成後右上角圖示列會出現 🏨 圖示

## 完整工作流程（推薦）

```
Google Travel 搜「台北中山區飯店」
  → 點右下「📥📥 批次抓全部」(自動逐間抓 3 OTA)
  → 開擴充 popup → 選入住日 → 點「📤 推送到 GitHub」
  → 30-60 秒後，手機/任何裝置開比價表都自動看到最新價
```

### 1. 批次抓（一次抓整頁）
1. Google Travel 搜尋區域，例如「台北中山區飯店」或「Beauty Hotels Taipei」
2. **確認 check-in / check-out 日期是你要的**（Google 常預設成週末，記得改）
3. 右下角點「📥📥 批次抓全部」
4. 擴充會自動逐間點開、等 3 OTA 載入、抓價、換下一間（含「再試一次」自動重試）
5. 跑完顯示「成功 N 間，跳過 M 間」

也可以用「📥 抓這間」只抓當前開啟的單一飯店。

- 自動辨識的飯店 id: own / bchic / qiancai / roumei / shemei / zhenmei / tianjin / yunfu / apt35 / napt
- 同 hotel + 同 check-in 重複抓會「更新」不會新增

### 2. 推送到 GitHub（手機也看得到）
**首次需設定一次：**
1. 擴充 popup → 展開「⚙️ GitHub 推送設定」
2. 貼上 GitHub Fine-grained PAT
   - 到 https://github.com/settings/personal-access-tokens/new 建立
   - 只授權 `hotelbchic/beautyhotel` 一個 repo 的 **Contents: Read and write**
   - 建議設 90 天到期
3. 「💾 儲存設定」（token 只存在你這台電腦，不外傳）

**之後每次推送：**
1. popup 上方選「發布哪個入住日期為最新」
2. 點「📤 推送到 GitHub」
3. 推送 `data/latest.json` + `data/history/<抓取日>.json` + 更新 `data/history/index.json`
4. GitHub Pages ~30-60 秒後更新，比價表自動拉到最新

### 3. （備用）只寫本機，不推 GitHub
抓完到 https://hotelbchic.github.io/beautyhotel/ ，右下角「📥 從擴充匯入」會把資料寫進這台電腦的 localStorage（手機看不到，適合臨時自己看）。

### 清資料
擴充 popup → 「🗑 清空已抓資料」（只清擴充儲存，不影響已推到 GitHub 的資料）

## 比價表頁面新功能（搭配本擴充）
- **自動讀遠端**：開頁面會 fetch `data/latest.json`，遠端比本機新就自動更新
- **📉 歷史趨勢分頁**：讀 `data/history/*.json`，畫各飯店最低價隨抓取日期的走勢（看 pickup）
- **Rate Parity 檢查**：自家三 OTA 價差 ≥5% 會在「我們的飯店」區塊跳警告，提醒某通路偷偷低價

## 技術細節
- Manifest v3
- 在 google.com/travel/*、hotelbchic.github.io/beautyhotel/*、api.github.com/* 三個 origin 運作
- 資料存 chrome.storage.local（不跨裝置同步；要跨裝置就用「推送到 GitHub」）
- GitHub 推送用 Contents API（先 GET sha 再 PUT），UTF-8 內容轉 base64

## 還沒做（未來可加，全 0 成本）
- [ ] chrome.alarms 排程：PC 開著時每天自動跑批次 + 推送
- [ ] 匯入/推送前 diff 預覽
- [ ] 歷史趨勢支援「固定入住日、看不同抓取日」的 pickup 專用視圖
