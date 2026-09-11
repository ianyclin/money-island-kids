# 小小理財島 PWA 重寫：架構契約

這份文件是建造代理的唯一契約。原則：**抄內容、換骨架。** 原專案（Next.js on Cloudflare，`app/`、`db/`、`lib/`）的文案、畫面結構、class 名稱、資料形狀、業務規則與錯誤訊息全部照搬；只把「D1 資料庫＋伺服器 API＋家庭登入」換成「單一裝置、瀏覽器本機儲存」。成品放在 `docs/`，由 GitHub Pages 直接提供，**沒有建置步驟**：純 ES modules、純 CSS、零外部 CDN。

## 1. 產出位置與檔案

```
docs/
  index.html              殼：<div id="app">、<div id="toast-root">、<div id="modal-root">；載入 styles.css 與 js/app.js（type=module）
  styles.css              已完成：Tailwind preflight 等價重置 ＋ 原 app/globals.css 原封不動
  manifest.webmanifest    照原 app/manifest.ts 內容；start_url 與 scope 一律 "./"
  sw.js                   從 ../stamps/sw.js 搬；改 VERSION、PREFIX="money-island-"、CORE、EXTRA
  icons/                  icon-192.png、icon-512.png、apple-touch-icon.png、favicon.ico（另行放入）
  js/
    util.js               html 樣板標籤、escape、金額與日期格式、id、Taipei 日期
    db.js                 localStorage 主儲存（load/save/隔離壞資料）、IndexedDB 快照、設定
    state.js              空白狀態、normalize（備份驗證器）、derive（畫面用衍生欄位）
    pin.js                家長操作碼：PBKDF2 雜湊、鎖定、本次開啟期間的解鎖狀態
    store.js              全部業務規則（從 db/money-store.ts 移植）
    quotes.js             證交所收盤價（改用 rwd 端點，瀏覽器可直接呼叫）
    backup.js             匯出／匯入：標準備份、完整可攜備份、分享／下載、檢查
    gist.js               GitHub Gist 雲端備份（從 ../stamps/index.html 1084–1363 行搬）
    ui/common.js          nav、toast、modal、avatar、InfoTip、profile 切換列、state gate
    ui/home.js            孩子首頁（app/page.tsx）
    ui/dreams.js          夢想與回顧（app/dreams/page.tsx）
    ui/history.js         所有紀錄（app/history/page.tsx）
    ui/parent.js          家長區（app/parent/page.tsx ＋ device-trust-panel.tsx 的備份部分）
    ui/setup.js           第一次使用（取代 app/family-access/page.tsx）
    app.js                路由、開機、每月獎勵、自動行情、SW 註冊、安裝提示
```

所有 import 用相對路徑（`./util.js`、`../util.js`），URL 一律相對（`./sw.js`），因為 Pages 網址是 `https://ianyclin.github.io/money-island-kids/`。

## 2. 渲染模型

不用框架。每個頁面模組輸出：

```js
export function render(ctx)      // 回傳 HTML 字串（用 html`` 樣板）
export function mount(root, ctx) // render 之後綁事件；用事件委派，root 是 #app
```

- `ctx = { state, view, profile, profiles, unlocked, navigate, refresh }`；`view` 是 `derive(state)` 的結果，`profile` 是目前選中的孩子。
- **整頁重繪的時機只有兩種**：路由切換、`store` 提交後（`commit()` 會呼叫 `app.refresh()`）。表單輸入不重繪，表單一律 uncontrolled，送出時讀 DOM。
- 需要即時預覽的欄位（零用錢拆分預覽、轉存預覽、收成額度）由 `mount` 內用 `input` 事件做局部更新，不重繪。
- 頁面自己的 UI 狀態（開著的 modal、正在編輯的 id、篩選字串、選中的月份）放在該模組的頂層變數，重繪後由 `render` 讀回，這樣重繪不會把使用者踢出編輯。
- Modal 用 `common.openModal(htmlString, {onClose})` 渲染進 `#modal-root`；它負責 backdrop 點擊關閉、Esc、focus 還原、`inert` 背景（作法照 stamps 1984–2076 行）。
- `html` 樣板標籤會 escape 所有插值；插值是陣列就串接；`null/false/undefined` 變空字串；用 `raw(str)` 才會原樣輸出。**禁止手動拼字串塞 innerHTML。**

## 3. 資料形狀

`state` 就是原專案 `app/money-types.ts` 的 `MoneyState`，一字不改，外加三個持久化欄位：

```js
{
  version: 1,
  family: { id, code, name },          // code 為 "MI-XXXXXX"（字母集 ABCDEFGHJKLMNPQRSTUVWXYZ23456789）
  profiles: KidProfile[],              // gardenSpecies 直接存在 profile 上（原本在 profile_preferences）
  activities: MoneyActivity[],         // 已套用編輯、已刪除的實體移除（原本用 activity_changes 覆蓋層，這裡直接改）
  projects, holdings, purchases, investmentPresets, dreamJars, reflections, harvests, savingsTransfers,
  savingsRate: 30,
  latestBackup: { id, reason, createdAt, copyStatus },   // 由 db.save 填：createdAt=最後儲存時間，copyStatus 反映 Gist 狀態
  backupHealth: { status: "ready"|"pending"|"failed", message },
  meta: { createdAt, updatedAt, selectedProfileId, installHintDismissed }
}
```

- 排序規則照原本：`activities` 依 `entryDate DESC, createdAt DESC`；`projects` 依 waiting→claimed→open→completed；`savingsTransfers` pending 優先；`dreamJars` 依 status, updatedAt DESC。`store` 每次提交前呼叫 `state.sortAll(state)`。
- **照片**：孩子頭像若是照片，`avatar` 存 `data:image/jpeg;base64,...`（上傳時用 canvas 壓到最長邊 256px、JPEG 0.82，超過 60,000 字元再以 0.5 重壓）。原 `ProfileAvatar` 已支援 `data:image/` 開頭，UI 不用改。
- **家長操作碼**不在 `state` 裡，存 `localStorage["money-island.v1.security"] = { salt, hash, iterations, failedAttempts, lockedUntil }`。
- **Gist 設定**不在 `state` 裡，存 `localStorage["money-island.v1.gist"]`（照 stamps）。
- `derive(state)` 回傳畫面用的 view：每個 profile 補 `rewardClaimedThisMonth`、`shortDreamBalance`（=spendingBalance）、`futurePrincipal`（原 readFuturePrincipals 規則：kind 為 allowance/project/sheet-deposit/savings-transfer 的 bankDelta 總和，減 harvest 的 amount，加 harvest-void，減 harvest-correction，下限 0）。derive 不寫回 state。

## 4. 儲存（db.js）

```js
export function load()                     // localStorage "money-island.v1" → state；壞資料先複製到 "money-island.v1.broken.<ts>" 再回 null
export function save(state, reason)        // 寫入；更新 state.latestBackup/backupHealth；排程 IndexedDB 快照（4 秒）與 Gist 同步（15 秒）
export function hasState()
export async function listSnapshots() / takeSnapshot(state) / restoreSnapshot(ts)   // IndexedDB "money_island" store "snapshots"，keyPath ts；保留最新 20 ＋ 60 天內每日最後一份（照 stamps 1057–1082、1364–1418）
export function estimateSize(state)        // JSON 長度；超過 3.5 MB 時 save 要 toast 警告
```

`save` 的順序照 stamps：先排程快照與雲端，再 try 寫 localStorage；QuotaExceededError 要顯示持久標記，不能只 toast。

## 5. 狀態與提交（state.js／store.js）

```js
// state.js
export function freshState({ familyName, kidNames, savingsRate })   // 種子照 money-store.ts seedNewFamily L341–376：孩子 emoji 🐯🐰🐼、accent 顏色、gardenSpecies 依序 tree/cherry/sunflower、常用標的 00646 與 0050、預設專案照 L1138–1161
export function normalize(raw)              // 完整移植 validateBackupEnvelope（L3207–3456）的規則：型別、長度、參照完整性、唯一性；失敗丟 Error("備份檔內容不正確：…")
export function derive(state)
export function sortAll(state)
export const KIND_NAMES                     // 從 app/history/page.tsx kindName 搬

// store.js（每支函式：驗證 → 修改 state → commit(reason)）
export function getState()
export function setState(next, reason)      // 還原備份用
export function subscribe(listener)         // app.js 用來重繪
export function commit(reason)              // sortAll → db.save → 通知 listener
export async function ensureMonthlySavingsRewards()
export function addTransaction({ profileId, kind, amount, label, operationId })
export async function setPiggyBankBalance({ profileId, balance, note, parentPin })
export async function updateActivityRecord({ action: "edit"|"delete", activityId, label, note, entryDate, parentPin })
export async function updateSavingsRate({ savingsRate, parentPin })
export async function updateSavingsTransfer({ action, profileId, amount, note, operationId, transferId, parentPin })
export function updateGardenSpecies({ profileId, gardenSpecies })
export async function updateProfile({ profileId, name, avatar, parentPin })
export async function addProfile({ name, parentPin })                 // 新增：上限 5 位
export async function removeProfile({ profileId, parentPin })         // 新增：只允許沒有任何紀錄、持股、夢想的孩子
export async function updateFamilyProject({ action, projectId, profileId, title, description, reward, parentPin })
export async function addInvestmentPurchase({ ... })  / voidInvestmentPurchase / correctInvestmentPurchase
export async function updateHoldingMarketValue({ holdingId, marketValue, parentPin })
export async function refreshTwseClosingPrices({ mode: "auto"|"parent", profileId, parentPin })   // 回傳 { updatedSymbols, unavailableSymbols, fetchedAt, source }
export async function recordAnnualHarvest / voidAnnualHarvest / correctAnnualHarvest
export async function updateDreamJar({ action, ... })
export function saveMonthlyReflection({ profileId, month, proudText, changeText, planText })
export async function updateInvestmentPreset({ action, presetId, symbol, name, category, sortOrder, parentPin })
export function getActivitiesPage({ profileId, query, kind, offset, limit })   // 回 { activities, total, nextOffset, kinds }
```

規則來源與行號都在 `db/money-store.ts`；建造時逐支對照原始碼移植，**錯誤訊息一字不改**。原本靠 SQL 唯一索引做的冪等（operationId）改成先查再寫。原本的 `withFamilyMutationLock` 不需要（單執行緒）。原本需要 `assertParentPin` 的函式一律 `await pin.assert(parentPin)`。

## 6. 家長操作碼（pin.js）

```js
export function status()                        // "setup" | "locked" | "unlocked"
export async function setup(pin)                // 4–8 位數字；PBKDF2-SHA256 100,000 次、16 bytes salt、256 bits（照 money-store.ts L202–216）
export async function assert(pin)               // 錯誤文案照 L754–774；5 次失敗鎖 15 分鐘；成功後記住本次開啟期間已解鎖
export async function change(currentPin, newPin)
export function isUnlocked()
export function lock()
```

## 7. 行情（quotes.js）

證交所 OpenAPI `STOCK_DAY_AVG_ALL` 沒有 CORS 標頭，瀏覽器不能直接打；改用有 `access-control-allow-origin: *` 的逐檔端點：

```
https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_AVG?date=YYYYMM01&stockNo=0050&response=json
→ { stat:"OK", date, title, fields:["日期","收盤價"], data:[["115/09/01","108.45"], …, ["月平均收盤價","107.34"]] }
```

- 取 `data` 中最後一列日期格式為 `ROC/MM/DD` 的資料，民國年＋1911 轉 ISO。
- 當月沒有資料（月初尚未開盤）就再查上個月。
- 每檔一個請求，12 秒逾時，逾時文案照 `lib/market-quotes.ts`。`isTwseSymbol` 規則照原本 `/^\d{4,6}[A-Z]?$/`。
- 回傳形狀照原 `ClosingQuote`：`{ symbol, name, price, asOf, source: "臺灣證券交易所 · STOCK_DAY_AVG", exchange:"TWSE", currency:"TWD" }`。

## 8. 備份（backup.js）

```js
export function exportEnvelope(state)                 // { format:"money-island-backup", version:1, exportedAt, family, state }
export function exportPortableEnvelope(state)         // 同上但 format:"money-island-portable-backup"，photos:[{profileId, contentType, base64}]，並把 state 內的 data URL 頭像改寫成 "/api/profile-photo?profileId=<id>"（與舊站格式相容）
export function inspect(parsed)                       // 回 { family, exportedAt, counts:{profiles,activities,dreams,holdings,reflections}, portable, photoCount }；驗證失敗丟 Error
export async function restore(parsed)                 // 舊站的完整可攜備份可以直接匯入：把 photos 轉回 data URL（重新壓縮）、"/api/profile-photo" 頭像沒有對應照片時改用 "🙂"；持股彙總一律從 holdings 重算（照 L3792–3806 的原則）
export async function shareOrDownload(json, filename) // 照 stamps 3858–3879：優先 navigator.share 檔案，其次 <a download>，最後複製到剪貼簿
```

## 9. Gist 雲端備份（gist.js）

整段從 `../stamps/index.html` 1084–1363 行搬，檔名常數改 `money-island-backup.json`，localStorage 鍵 `money-island.v1.gist`。要 stub 的相依：`state`（改讀 `store.getState()`）、`normalize`、`save`、`toast`、`refreshSettings`（改成呼叫 app.refresh）、`resetRuntime`（改成 `pin.lock()` 加清空頁面暫存）。UI（連線、決定卡、刪除雲端備份、中斷）照 stamps 3547–3818 行的行為搬到家長區的「資料與備份」面板。

## 10. 路由與開機（app.js）

- hash 路由：`#/`（home）、`#/dreams`、`#/history`、`#/parent`、`#/setup`。`PrimaryNav` 的 href 改成這些。
- 開機：`db.load()`；沒有 state 就導到 `#/setup`；有 state 就 `ensureMonthlySavingsRewards()`（對應原本每次 GET /api/state），然後渲染。
- `visibilitychange` 回前景：再跑一次每月獎勵；30 分鐘內最多一次自動行情（照 `app/money-state-cache.tsx` 的 `refreshAutomaticMarketQuotes` 規則，localStorage 鍵 `money-island-auto-quote`）。
- 選中的孩子存 `state.meta.selectedProfileId`（原本在 localStorage `money-island-profile`）。
- SW 註冊、`shell-updated` 提示、iOS 安裝提示、`visualViewport` 鍵盤頂高、`navigator.storage.persist()`：全部照 stamps 4006–4039、4088–4097。

## 11. 第一次使用（ui/setup.js）

取代家庭入口。兩條路：

1. **建立新帳本**：家庭名稱（2–30 字）、孩子名字 1–3 個（預設三格，空白略過，至少一個）、家長操作碼（4–8 位數字，輸入兩次）、預先儲蓄比例（預設 30%，5% 為單位）。按下去 → `freshState` → `pin.setup` → `db.save` → 導到首頁。
2. **從備份檔還原**：選檔 → `backup.inspect` 顯示摘要 → 確認 → `backup.restore` → 若沒有操作碼再要求設定 → 導到首頁。

視覺用 `access-shell`／`access-hero`／`access-card` 那組 class，文案要改寫成單機版：不再提家庭代碼、家庭密碼、救援碼、ChatGPT、OpenAI、信任裝置。

## 12. 文案需要改寫的地方（單機版）

其餘文案一字不改。只有這些地方因為架構不同要改：

| 原文位置 | 原文 | 改成 |
|---|---|---|
| home 記帳按鈕 | 正在存進雲端… | 正在儲存… |
| home 記帳 modal | 儲存後會自動留下雲端備份 | 儲存後會自動備份在這台裝置；開啟雲端備份後也會同步到你的 GitHub |
| home topbar 狀態 | 等待第一次備份／剛剛已備份／同步失敗… | 由 `common.backupStatusText(state)` 產生：剛剛已儲存／HH:MM 已儲存；Gist 開啟時加「· 雲端已同步」或「· 雲端待同步」 |
| parent 指南「第一次設定」步驟 1 | 建立家庭：保存家庭代碼… | 設定家長操作碼與孩子名字，並在「資料與備份」開啟雲端備份 |
| parent 指南「資料與救援」 | 每次異動會自動保存雲端版本／…離線救援碼… | 每次異動會自動存在這台裝置並保留快照；家長可下載備份檔或開啟 GitHub 雲端備份；換手機時用備份檔或雲端備份拿回來 |
| parent 指南「四個頁面」家長區 | …信任裝置與資料備份 | …與資料備份 |
| parent 自動更新 InfoTip | 登入家庭或回到網站時… | 打開 app 或回到前景時… |
| parent 表單 notice | 資料異動後會自動備份 | 資料異動後會自動儲存 |
| DeviceTrustPanel | 整個「家庭帳戶／信任裝置」段落 | 改成「資料與備份」：下載帳本備份、下載完整可攜備份、上傳還原、IndexedDB 快照列表與還原、Gist 雲端備份設定 |
| savedStatus() 的後綴 | ；雲端備份稍後重試／；雲端副本會在背景完成 | Gist 開啟且同步失敗時「；雲端備份稍後重試」，否則不加後綴 |
| history／dreams 的 401 導向 | window.location.replace("/family-access") | 刪除，單機版沒有登入 |

## 15. 頁面模組能用的東西（ui/common.js 與 ctx）

頁面模組只准 import：`../util.js`、`./common.js`、`../store.js`、`../state.js`、`../pin.js`、`../backup.js`、`../quotes.js`、`../gist.js`、`../db.js`（只准用 listSnapshots／restoreSnapshot）。不要自己寫 toast、modal、avatar、nav。

```js
// ui/common.js
export function primaryNav(active)                         // "home"|"dreams"|"history"|"parent"；href 是 #/、#/dreams、#/history、#/parent
export function showStatus(message, tone = "success")      // tone: success | waiting | error；自動消失（error 7 秒，其餘 4.5 秒）
export function dismissStatus()
export function openModal(htmlString, { labelledBy, onClose, closeOnBackdrop = true })   // 渲染進 #modal-root；回傳 modal 根節點，之後自己在上面綁事件
export function closeModal()
export function profileAvatar(avatar, name)                // 回傳 html 片段
export function infoTip(content, { label = "查看說明", align = "left" } = {})
export function profileChips(profiles, selectedId)         // topbar 的 profile-chip 列；按鈕帶 data-choose-profile="<id>"
export function profileRow(profiles, selectedId, subtitleOf) // parent-profile 列；按鈕帶 data-choose-profile；subtitleOf(profile, isActive) 回小字
export function stateGate(error, onRetry)
export function backupStatusText(state)
export function savedStatus(state, message)                // 回 { message, tone }
export async function confirmDialog(message)               // 回 Promise<boolean>，取代 window.confirm

// ctx（app.js 傳給 render/mount）
ctx.state        // store.getState()
ctx.view         // derive(state)：profiles 已補 rewardClaimedThisMonth、futurePrincipal、gardenSpecies、shortDreamBalance
ctx.profile      // 目前選中的孩子（view.profiles 裡的那個）；沒有任何孩子時為 null
ctx.profiles     // view.profiles
ctx.unlocked     // pin.isUnlocked()
ctx.pinStatus    // pin.status()："setup" | "locked" | "unlocked"
ctx.navigate(hash)         // 例如 ctx.navigate("#/dreams")
ctx.refresh()              // 立刻整頁重繪（store.commit 之後 app.js 會自動呼叫，一般不必手動）
ctx.chooseProfile(id)      // 寫入 state.meta.selectedProfileId 並重繪
```

慣例：
- 事件綁在 root 上用委派：`root.addEventListener("click", (event) => { const button = event.target.closest("[data-action]"); … })`。按鈕用 `data-action="claim-project" data-id="…"` 這種屬性，不要 inline onclick。
- 呼叫 store 時包 try/catch：成功用 `showStatus(savedStatus(state, "…").message, tone)`，失敗用 `showStatus(errorMessage(error, "儲存失敗"), "error")` 並把文案塞進該表單的 `.form-error`。busy 狀態：送出前把按鈕 disabled 並換文案（照原本的「正在儲存…」），完成後 store.commit 會觸發重繪，所以不必手動還原。
- 家長操作碼：頁面上的解鎖表單呼叫 `pin.status()` 決定要顯示 setup 還是 locked；送出時 `await pin.setup(value)` 或 `await pin.assert(value)`，成功後 `ctx.refresh()`。之後呼叫 store 時把同一個 pin 字串當 `parentPin` 傳進去（store 會再 assert 一次，已解鎖時會直接通過）。
- 家長區的「資料與備份」面板：Gist 部分由 gist.js 提供 `renderGistPanel()` 與 `mountGistPanel(root)`，parent.js 直接嵌入；備份檔的下載、上傳檢查與還原用 backup.js；快照列表用 db.js 的 listSnapshots/restoreSnapshot。

## 13. 不做的東西

家庭代碼與密碼、信任裝置、離線救援碼、用孩子名字找回、legacy family claim、多家庭。`app/chatgpt-auth.ts`、`worker/`、`build/` 不搬。

## 14. 驗收

- 在瀏覽器以 `docs/` 為根打開能跑完：建立帳本 → 記零用錢（30% 拆分）→ 花費 → 申請多存 → 家長解鎖核准 → 小專案 create/claim/submit/approve → 夢想罐 create/complete → 買入 → 手動市值 → 收成 → 回顧 → 匯出 → 匯入舊站的完整可攜備份。
- 所有 store 函式的錯誤文案與原始碼一致（judge 會逐支比對）。
- 沒有任何 `fetch` 打到舊站或任何非證交所、非 GitHub API 的網址。
