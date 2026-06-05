# Google OAuth 授權頁面睇唔到《私隱權政策／服務條款》— 點樣修正

你張截圖個藍色提示「睇唔到…《私隱權政策》或《服務條款》的連結」通常代表：**你喺 Google Cloud Console → OAuth consent screen 入面，未填（或未公開）Privacy Policy URL / Terms of Service URL**。

本資料夾已準備好：

- `index.html`：加咗固定底欄連結（《私隱權政策》《服務條款》），方便用戶隨時打開。
- `privacy.html`、`terms.html`：補齊基本 meta（description / robots / canonical），方便公開展示。

## 1) 先確認 GitHub Pages 連結係可公開開到

部署後請用瀏覽器直接打開：

- https://cw91020251212.github.io/privacy.html
- https://cw91020251212.github.io/terms.html

兩條 link 要：

- **https**
- **唔需要登入**
- **唔會 404 / 轉去奇怪 URL**

## 2) Google Cloud Console 設定（最關鍵）

Google Cloud Console → **APIs & Services** → **OAuth consent screen**

喺 App information / Links（介面名稱可能略有不同）填入：

- **Privacy policy**: `https://cw91020251212.github.io/privacy.html`
- **Terms of service**: `https://cw91020251212.github.io/terms.html`

然後 Save / Publish（如有「Publishing status」要轉到 In production / Published）。

> 註：即使你網站本身有放連結，如果 Console 無填，授權頁面都會出現你截圖嗰個提示。

## 3) 如果仲係見唔到連結

常見原因：

- OAuth consent screen 未發佈（仍然 Testing / Draft）
- 你用緊另一個 Google Cloud project / OAuth client
- URL 打錯（例如少咗 `.html` 或大小寫唔同）

---

如你想我順手幫你檢查：你而家 OAuth consent screen 入面填緊邊兩條 URL（私隱/條款）？你貼出嚟我可以對一對。