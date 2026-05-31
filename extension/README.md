# beautyhotel 房價同步 Chrome 擴充

把 Google Travel 上看到的飯店 3 OTA 房價，一鍵存到 hotelbchic.github.io/beautyhotel 比價表，不必手動輸入。

## 安裝
1. Chrome 開啟 `chrome://extensions/`
2. 右上角開啟「開發人員模式」
3. 點「載入未封裝項目」→ 選這個 `extension` 資料夾
4. 完成後右上角圖示列會出現 🏨 圖示

## 怎麼用

### 抓 1 天 1 間
1. Google Travel 找到任一飯店 (例如 Hotel Bnight 峻美商旅)，點「查看價格」展開 OTA 列表
2. 確認 check-in / check-out 日期是你要的 (可改)
3. 右下角點「📥 抓房價」紅色按鈕
4. 成功會跳 toast，計數 +1

### 抓多天多間 (做 7 天走勢)
重複上面流程：每換一個日期或飯店，再點一次「📥 抓房價」。
- 已知支援的飯店 (id 自動辨識): own / bchic / qiancai / roumei / shemei / zhenmei / tianjin / yunfu / apt35 / bstay
- 同 hotel + 同 check-in 重複抓會「更新」不會新增

### 匯入到比價表
1. 抓完一輪到 https://hotelbchic.github.io/beautyhotel/
2. 右下角會出現「📥 從擴充匯入」按鈕
3. 點下去 → 自動寫到 localStorage → 頁面 reload → 房價更新
   - check-in = 今天的 → 寫入「今日比價」三欄
   - check-in = 今天 +1~+29 → 寫入「30 天日曆」對應格 (取最低 OTA 價)

### 清資料
擴充 popup 視窗 → 「🗑 清空所有已抓資料」(只清擴充自己的儲存，不影響網頁 localStorage)

## 技術細節
- Manifest v3
- 只在 google.com/travel/* 和 hotelbchic.github.io/beautyhotel/* 兩個 origin 跑
- 資料存在 chrome.storage.local (跨擴充 sync 不會自動同步到其他電腦)
- 匯入時寫的是頁面的 localStorage `bh_prices_v1`，跟頁面原本的手動編輯共用同一份儲存

## TODO
- [ ] 自動模式：popup 點一顆按鈕，後台自動開 10 間 × 7 天 = 70 個分頁串行抓 (目前要手動切)
- [ ] 匯入時跳 diff 預覽
- [ ] 把抓到的價格 push 到 GitHub raw 而不是只存 localStorage，讓任何人開頁面都看得到
