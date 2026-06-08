# GitHub Pages 發佈（cw91020251212.github.io）設定指引

你講嘅 `cw91020251212.github.io` 代表你想用 **User/Organization Pages**（根域名），做法係：

## 1) 確認 Repo 名（最重要）
你 GitHub 帳號係：`cw91020251212`

你需要建立（或已存在）一個 repo 名字 **完全一樣**：
- `cw91020251212.github.io`

> 只要 repo 名唔係呢個，根域名就會一直 404。

## 2) 準備要放上去的檔案（同一層目錄 /root）
將以下檔案放喺 repo 根目錄（同一層）：
- `index.html`  ← 用我交付嘅 `日曆記事本_加入大量刪除.html` 改名做 `index.html`
- `manifest.webmanifest`
- `sw.js`
- `icon.svg`（如果你原本有；manifest 有引用佢）

> 三個核心檔一定要同層，因為 HTML 內係用 `manifest.webmanifest` 同 `sw.js` 相對路徑。

## 3) 開啟 GitHub Pages
去到：repo → **Settings → Pages**
- Source: Deploy from a branch
- Branch: `main`（或 `master`）
- Folder: `/ (root)`

Save 後等 1–5 分鐘。

## 4) 驗證唔再 404
用 Chrome 打開：
- `https://cw91020251212.github.io/`

正常應該會見到日曆頁。

## 5) 安裝成 PWA（先會出現「分享目標」）
Android Chrome：
1. 開 `https://cw91020251212.github.io/`
2. 右上角 ⋮ → **安裝應用程式 / 加到主畫面**
3. 用「檔案管理」分享 mp3/mp4 → 分享清單應該會見到日曆記事本

> 注意：如果你係用 `file://` 打開 HTML，Service Worker / Share Target 會失效，分享清單通常唔會出現。

## 6) mp3/mp4 入嚟會去邊度？
目前我已做咗：
- 分享入嚟 **圖片**：當作相片（dataUrl）
- 分享入嚟 **mp3/mp4/pdf 等非圖片**：當作 **附件**，會出現喺編輯器嘅「📎 附件」區，可以按「開啟」

如你想附件直接顯示 **audio/video 播放器預覽**（`controls`），我可以再幫你加。
