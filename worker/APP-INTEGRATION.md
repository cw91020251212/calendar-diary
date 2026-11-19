# 正式網站推播整合

正式網站是 GitHub Pages PWA，API 為既有 Cloudflare Worker `calendar-diary-reminders`，資料庫為既有 D1 `calendar-diary-reminders`。前端入口在 `docs/index.html`、推播處理在 `docs/sw.js`；Worker 及測試在 `worker/`。不得重建或清空訂閱、提醒、VAPID secret、rate limit bindings 或 cron。

## 兩種互相獨立的通知

使用者先在提醒視窗按「啟用／同步全天手機通知」並允許瀏覽器通知。之後，日曆記事儲存時會自動排在記事所屬日（新開 App 時亦會同步本機今日及未來日曆記事）；記事簿空間不參與。全天通知由 Worker 排程在當日發送，日終再發送同 tag 關閉推播。通知標題可在提醒視窗改成通用字樣以保護私隱，文章首段摘要仍會顯示。指定時間響一次保留為「設定提醒」，兩者使用不同 reminder ID。

推播訂閱及排程依賴瀏覽器已授權及已建立的 Push subscription。背景同步不會自行彈出權限或創建訂閱；權限撤銷或重新安裝後，使用者需再次主動啟用。服務每分鐘檢查到期列，故通知並非精確鬧鐘。

## 私隱與可靠性

記事標題、通知摘要、日期時間、隨機識別碼及 Push subscription 會傳給 Cloudflare Worker／D1；圖片和附件不會傳送。勿將敏感內容寫入通知摘要；通知亦可能出現在鎖定畫面。推播可送達時間受網絡、瀏覽器、作業系統、省電及勿擾影響。`requireInteraction` 和日終 close push 均為最佳努力，平台可能自動收起或忽略清除要求，不能承諾全天常駐或午夜準時消失。

## 遷移和部署

只可增量執行 `worker/migrations/0002_all_day_notification_content.sql`。欄位預設值讓舊提醒繼續顯示通用通知；不觸碰既有列。部署前在 `worker/` 執行 `npm test` 及 `npm run dry-run`，部署後核對 `/v1/config` 及 D1 migration 記錄。正式訂閱不得用於推播測試；測試應以 mock Web Push 和記憶體 SQLite 完成。
