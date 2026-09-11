# 小小理財島（Money Island Kids）

給家庭一起使用的兒童零用錢與夢想管理 app：先留一部分給未來、練習記錄與選擇，並為夢想慢慢累積。

這個倉庫有兩份東西：

| 位置 | 是什麼 | 狀態 |
|---|---|---|
| `docs/` | **單機版 PWA**：純 HTML／CSS／JS，不用建置，由 GitHub Pages 直接提供，加到手機主畫面就能用。帳本存在裝置裡，附匯出／匯入備份與 GitHub Gist 雲端備份。 | 現行版本 |
| `app/`、`db/`、`lib/`、`worker/` | 原本跑在 ChatGPT 網站託管（Cloudflare Workers ＋ D1 ＋ R2）的 Next.js 版本原始碼，隱私快照。 | 只留作對照，不再部署 |

單機版的規則、文案與畫面都從原版逐行移植；架構與模組契約在 [notes/pwa-architecture.md](notes/pwa-architecture.md)。

## 開成網頁（GitHub Pages）

1. 倉庫的 **Settings → Pages → Build and deployment → Source** 選 **Deploy from a branch**。
2. Branch 選 `main`、資料夾選 **`/docs`**，按 Save。
3. 等 1–2 分鐘，網址會是 `https://<你的帳號>.github.io/money-island-kids/`。

## 加到手機主畫面

- **iPhone／iPad**：用 Safari 打開上面的網址 → 分享 → 加入主畫面。之後從主畫面的圖示打開會全螢幕、沒有網址列，離線也能用。
- **Android**：用 Chrome 打開 → 右上角選單 → 安裝應用程式（或「加到主畫面」）。

第一次打開會請你建立帳本（家庭名稱、孩子名字、家長操作碼），或直接匯入以前下載的備份檔（含舊站的「完整可攜備份」）。

## 資料在哪裡、怎麼備份

- 帳本存在該裝置的瀏覽器儲存空間，**不會上傳到任何伺服器**。
- 每次異動會自動存檔，並在裝置上保留最近的快照（誤刪可還原）。
- 家長區的「資料與備份」可以下載備份檔、上傳還原，也可以貼一把只有 gist 權限的 GitHub 金鑰開啟雲端自動備份，換手機時整份拿回來。
- 刪掉主畫面的 app 圖示或清除瀏覽器資料，帳本就沒了；請養成偶爾下載備份的習慣。

## 本機開發

不需要 Node。任何靜態伺服器都行，例如：

```bash
python3 -m http.server 8792 --directory docs
```

然後開 <http://localhost:8792>。引擎的自我測試在 <http://localhost:8792/dev/selftest.html>（119 條斷言，跑完最後一行會印 PASS／FAIL）。

## 改了程式要記得的一件事

`docs/sw.js` 最上面的 `VERSION` 每次改程式都要往上加一號（v2 → v3）。Service Worker 是整組版本快取：手機抓到新的 sw.js 才會重新下載所有檔案，並跳「有新版本」提示。沒改 VERSION，已安裝的手機會一直用舊版。新增了 js 檔也要加進 `CORE` 清單。

## 證交所收盤價

投資持股的市值會在打開 app 時自動向臺灣證券交易所查最新收盤價（每 30 分鐘最多一次），也可以由家長手動輸入市值。不是即時報價。
