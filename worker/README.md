# 日曆記事本背景提醒

**現況（2026-11-19）：** 正式 GitHub Pages 已整合背景提醒；Cloudflare 已有 `calendar-diary-reminders` Worker、同名 D1 和每分鐘排程。部署前應核對線上版本和現有綁定，保留 `VAPID_PRIVATE_KEY` secret，切勿建立新資料庫或覆蓋其他服務。推播通知不含記事標題或正文；訂閱資料、提醒 ID 和時間仍屬敏感資訊。

設定及取消背景提醒需要網絡，手機須由使用者允許通知；iPhone／iPad 需要先加入主畫面。通知可能受網絡、省電及勿擾影響；系統接受設定不代表手機已收到。以下是整合前的歷史草稿記錄，其中「未部署」、設定占位及尚未整合等描述不再反映現況。

## 結論

網站目前是 GitHub Pages 靜態 PWA。線上版「提提我」會建立並下載行事曆檔；現有 Service Worker 負責離線快取和分享接收，沒有推播接收程式。因此網頁關閉後，網站本身沒有可以在指定時間喚醒的排程器。

免費的 Web Push 可以在 Android 上於頁面關閉時由 Service Worker 顯示系統通知，但必須有推播伺服器在到期時間發送訊息。此草稿採 Cloudflare Worker + D1 免費層：Worker 每分鐘掃描一次到期提醒，再使用標準 Web Push 發送通知。

## 草稿架構

- `src/index.js`：Worker API 與每分鐘排程；提供查詢公開 VAPID key、註冊推播、設定／取消提醒、停用推播及到期發送，並要求 IP 與裝置兩層限流。
- `migrations/0001_init.sql`：D1 資料表。只存裝置 token 的雜湊、推播訂閱資料和提醒 ID／時間／狀態；不存日記標題或內文。
- `client/reminder-push-client.js`：瀏覽器端訂閱、設定提醒和取消提醒的草稿。裝置 token 在本機隨機生成並留在 `localStorage`。
- `client/service-worker-push-snippet.js`：可併入現有 `docs/sw.js` 的背景接收與通知點擊處理；點通知會回到日記網站並帶上提醒 ID。
- `APP-INTEGRATION.md`：線上日記 HTML 的整合點及最低驗收測試。
- `wrangler.jsonc`：本機草稿設定，D1 ID 和公開 VAPID key 均為明確占位值；不能直接作為已部署設定。

通知採通用文字「有一個記事提醒到時間了」，避免將記事內容傳上後端。點擊通知會開啟網站。要讓它直接定位到原記事，還需把 `reminder` ID 與本機記事日期／記錄連接；這一步尚未整合至大型 `docs/index.html`。

## 免費層與時間精度

按 Cloudflare 官方文件，Workers Free 每日有 100,000 次請求額度；D1 Free 每日 5 百萬 rows read、100,000 rows written，總儲存額度 5 GB。每分鐘一次的排程約 1,440 次／日，單一使用者的提醒流量預期遠低於這些額度。超過免費額度時服務可能停止處理。

Cloudflare 官方文件亦指出 Workers Paid 最低為每帳戶每月 USD 5；Workers Free 是預設方案。只讀 API 無法列出帳戶計費訂閱（目前連線缺少 Billing Read 權限），但已存在的 Worker 回報 `usage_model: standard`，而官方文件說 Standard usage model 可用於 Workers Paid。這是付費風險訊號而非完整帳單證明；在使用者確認帳戶方案前，不能保證新 Worker／D1 完全免費，也不會嘗試啟用 Paid。

Cron 排程是分鐘級，不是精確到秒。手機需要網絡接收推播；Android 通知權限、省電模式、勿擾、瀏覽器推播服務及手機離線，都可能使通知延遲或靜音。若使用者離線太久，草稿設為最多延後一小時投遞，超過兩小時的舊通知會被 Service Worker 丟棄。它是背景推播，不是可離線保證響鈴的原生 Android 鬧鐘，也不能保證一定以浮動橫幅顯示。

## 尚未完成的網站整合與部署條件

1. 加入「啟用背景提醒」設定；須由使用者在 Android 主動點擊並允許通知，部署後還需把 PWA 加到主畫面。
2. 把目前「下載日曆檔」流程改為預設排程背景提醒；行事曆匯出可保留為獨立選項，而不是要求匯入才能收到通知。
3. 每個本機提醒產生穩定 ID，時間變更時更新後端，刪除記事時取消後端排程；點擊通知後用 ID 開啟本機記事。
4. 將 Service Worker 版本號／快取名稱更新，確保 Android 收到新版推播程式。
5. 在日記網站設定頁加上連線狀態和停用／撤銷訂閱操作。
6. 草稿現已加入 Cloudflare Rate Limiting bindings：每個路由的來源 IP 每分鐘最多 30 次、每個裝置 token 每分鐘最多 60 次；缺少限流 binding 或限流服務錯誤時會 fail closed。請求 body 也會檢查實際大小上限。限流是近似值、各 Cloudflare 地點分開計數且可能超出設定，不能當作嚴格的全域身份驗證；共用手機網絡的多位使用者也可能共用 IP 限額。若日後擴大公開服務，還需考慮 Turnstile／登入配對等更強措施。
7. Cloudflare Workers 費用層級目前未核實，既有 Worker 的 `standard` usage model 是風險訊號；確認是 Workers Free 且有明確部署授權前，不建立 D1、不設 VAPID secrets、不發布 Worker，也不修改／發布網站。

## 本機檢查

- `npm test`：3 項手機本地日期時間解析測試通過。
- `npm run dry-run`：Worker 成功 bundle（只檢查，不發布）。
- 本機 D1 schema 執行成功；使用假訂閱資料測試 `/v1/config`、`/v1/subscribe`、`/v1/reminders` 和取消端點均回覆成功。
- 沒有真實 VAPID key、Cloudflare 資源或 Samsung 手機推播測試；因此目前只能確認程式草稿可建置和 API 可本機往返，不能聲稱已收到真實通知。

## 官方依據

- [MDN：Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)：推播可在網頁未開啟時送至 Service Worker。
- [Cloudflare：Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)：支援每分鐘排程。
- [Cloudflare：Workers limits](https://developers.cloudflare.com/workers/platform/limits/)：Workers Free 限額。
- [Cloudflare：Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)：Free 預設方案、Workers Paid 每月最低 USD 5，以及 Standard usage model 資訊。
- [Cloudflare：Rate Limiting bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)：限流 binding 設定；近似值、按 Cloudflare 地點計數，可能超出限制。
- [Cloudflare：D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)：D1 Free 額度。
- [Cloudflare：Push notifications](https://developers.cloudflare.com/agents/agent-class/communication-channels/webhooks/push-notifications/)：Service Worker 在頁面關閉後接收推播的架構。
