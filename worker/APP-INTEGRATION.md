# 線上日記網站整合草案

本檔只描述如何把 Worker 草稿接到目前網站；尚未修改 repo 副本中的 `docs/index.html`／`docs/sw.js`，也未發布。Cloudflare Workers 費用層級目前未核實，故不可部署。

## 確認到的線上位置

網站實際頁面包含 `calendarReminderTimeInput` 的定時提醒對話框；專案的 `docs/index.html` 有對應版本，Service Worker 是 `docs/sw.js`。線上「提提我」現在打開「設定手機行事曆提醒」對話框；確認後下載 `.ics`，並只在 `localStorage` 留日期、時間、標題供本機狀態欄顯示。它沒有在本機建立 OS alarm，也沒有推播 listener。

## 建議整合次序

1. 在「設定與備份」增加「啟用背景提醒」按鈕。只有使用者主動點擊後才請求 Android 通知權限，取得 Service Worker 訂閱並送到 Worker。網站載入時不自動彈權限視窗。
2. 將提醒視窗主按鈕改為「設定背景提醒」，不再要求下載／匯入行事曆檔；行事曆匯出可保留為獨立的次要選項。
3. 修改 `confirmCalendarReminder()`：先驗證手機本地日期時間，建立 UUID，再把 `{id, dueAt}` 傳給 Worker；收到成功回應後，將 `{id, date, time, title, createdAt}` 存在現有 `diary_local_reminders_v1`，並顯示成功狀態。失敗時明確顯示未排程，不能假裝成功。
4. 把 `client/reminder-push-client.js` 的功能併入目前內嵌 JavaScript，或另行部署為同一網站目錄的 ES module。部署後把 `API_BASE_URL` 換成實際 Worker URL；公開 VAPID key 可由 Worker `/v1/config` 讀取，私鑰只放 Worker secret。
5. 將 `client/service-worker-push-snippet.js` 合併入 `docs/sw.js`，保留現有分享目標和快取行為；調整 SW cache 名稱及註冊版本 query，確保已安裝手機取得更新。
6. App 啟動時讀取 `?reminder=<id>`，在本機提醒清單查日期，打開當日記事／提示；關閉記事或取消提醒時呼叫 `/v1/reminders/cancel`。停用推播時呼叫 `/v1/unsubscribe` 並刪除本機 token。
7. Worker 草稿需帶上 `IP_RATE_LIMITER` 與 `DEVICE_RATE_LIMITER` bindings；限流是近似值、按 Cloudflare 地點分開計數，不能視為嚴格身份驗證。部署前需先確認帳戶在 Workers Free，且不會因現有 Workers Paid 訂閱或其他計費方案產生費用。

## 最低驗收測試

- 新安裝的 Samsung S24 Chrome／主畫面 PWA：按「啟用」後可取得通知權限及訂閱；拒絕權限時 UI 說明原因，不建立提醒。
- 建立 3–5 分鐘後提醒，完全關閉網站頁面，手機有網絡時收到 Android 系統通知；按通知開啟 App 並定位至正確日期。
- 更改時間／取消提醒後，舊時間不再彈；重新整理或重啟瀏覽器後排程仍有效。
- 重新安裝／清除網站資料、通知權限被撤銷、網絡中斷、勿擾及省電模式都有清楚的狀態與說明。
- 測試通知只含通用提示文字；確認 Cloudflare D1 不包含記事文字、標題、圖片或附件。

## 必須保留的產品說明

背景提醒依賴網絡推播，不等同 Android 原生鬧鐘：Worker 排程每分鐘檢查，推播服務、網絡、省電、通知權限、勿擾和瀏覽器設定均可能使通知延遲或不顯示；也不能保證系統浮動橫幅。不可再標示「不需伺服器」或聲稱精確到秒。
