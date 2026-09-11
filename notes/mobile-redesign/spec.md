# 小小理財島 手機版重新設計 —— 最終建造規格（修訂版）

版本：綜合定稿 v2（回應兩位裁判的擋下／應修／建議，供 builder 直接動工）
依據：`notes/mobile-redesign/brief.md`、`measurements.json`、六份理解報告（intent／home／dreams／history／parent／reference）、四份提案、三位裁判評分、**本輪兩位裁判（理念與功能完整性／手機實作陷阱）的逐條覆核**

---

## 0. 決策依據與骨幹

三位裁判（理念守門／家庭可用性／工程可行）交叉評分後，**提案3「最小改動角度」總分最高**（8.6 + 6 + 9 = 23.6），且是理念守門與工程可行兩位裁判各自的勝出方案。本規格以提案3為骨幹，逐條核對三位裁判的「可移植」與「警告」後，做以下取捨：

- **完全採納提案3的工程紀律**：不新建任何浮層／分頁狀態系統，一律沿用既有 `openModal()`／`<details>`／`.parent-profile-row` 橫向捲動三種既有機制；新路由只加一條（`#/parent/investments`），且用「整段搬移既有 markup，不重寫」的方式建立。
- **本規格在提案3骨幹之外，唯一新增的實質範圍：首頁貼底常駐「記一筆」按鈕列（`.record-bar`）。** 理由見家庭可用性裁判評分（提案3全場最低 6 分，核心原因是記帳按鈕不是貼底常駐）。工程風險可控（技巧與貼底 tab bar 相同、已驗證一次），仍在第 8 節列為需要作者知情同意的拍板題。
- **移植的其他要點**（逐項標明來源，細節見各節）：從提案4移植過年投資收成依月份自動展開、家長端「快速動作」與「待辦」的視覺紀律；從提案1移植 23 項必留功能逐項對照表、十條原則核對表；從提案2移植 wallet 卡片文案「一字不改」的承諾；從工程可行裁判移植「未來想做 sheet 效果一律擴充 `openModal`，不建第二套 session」。

### 0.1 本輪修訂：兩位裁判的擋下與應修，逐條回應

任務要求「所有『擋下』與『應修』都要處理（採納或明確反駁），『建議』擇優採納」。逐條處理結果彙總如下，細節在對應章節展開；**全部 5 條「擋下＋應修」都是實際核對原始碼後確認為真的缺陷，本輪一律採納並給出具體修法**，沒有反駁任何一條：

| 來源 | 級別 | 缺陷 | 本輪修法（詳見章節） |
|---|---|---|---|
| 理念裁判 | 擋下 | `.record-bar` 樣式只包在 650px 斷點，卻無條件拿掉桌機本來就有基準樣式的 `.hero-actions`，iPad／桌機記帳按鈕會失去樣式 | 不再刪除 `.hero-actions` markup，改用 CSS 依斷點切換顯示；兩組按鈕共用同一組 `data-action`，零新增 JS（2.1、3.1） |
| 手機裁判 | 擋下 | `.site-shell` 帶 `overflow:hidden`（全站唯一一個這樣設的 shell），恰好是新增兩層貼底固定元素的容器，是 WebKit「fixed 元素被裁」bug 的典型觸發條件 | 把 `.site-shell` 的 `overflow:hidden` 改成 `overflow-x:hidden`（只保留原本「防止水平方向意外出現捲軸」的防禦用途，拿掉會裁切垂直方向 fixed 元素的風險），不採用「整個搬到 `#app` 外面」的重構方案（會需要動 `index.html`，超出 brief.md 列出的可改檔案清單，且增加同步複雜度不成比例）；上線前列入 3.7 節真機驗收清單 (3.1、3.7) |
| 手機裁判 | 擋下 | 新增的解鎖 modal／校正撲滿 modal 沒有比照首頁記帳 modal 已驗證過的「重繪後自動重開＋回填」機制，家長輸入到一半會被背景重繪無聲清空 | 明文規定：任何新增的 modal 表單一律照抄 `home.js` 的 `action`／`openModalKind` 模式（module-scope 旗標存「是否該開」與「已輸入的值」＋`mount()` 裡的重開檢查），並給出具體程式骨架（1.2、2.4、3.2、3.3） |
| 手機裁判 | 應修 | `body{padding-bottom:64px}` 與各頁 shell 既有的 `padding-bottom:80px` 是不同選擇器、會疊加不會取代，四頁 footer 下方多出空白 | 拿掉通用 `body` 規則，改用單一 `--dock` CSS 變數（app.js 依當頁渲染出的固定元素種類設定 `<html data-dock="...">`），四個 shell 的 `padding-bottom` 全部改成 `var(--dock)`，只有一個真相來源（3.1、3.6） |
| 手機裁判 | 應修 | `.status-toast` 的 `bottom` 沒有把新增的貼底固定列高度算進去，會浮在貼底列上方一小截或視覺上疊在按鈕列中間 | `.status-toast` 的 `bottom` 計算式加上同一個 `--dock` 變數（3.1、3.6） |
| 手機裁判 | 應修 | `.project-admin`／`.preset-admin`／`.parent-device-grid`／`.new-dream-card` 四處既有 `<summary>` 沒有隱藏 Safari 原生三角形，本次把折疊變成排版骨幹後，這個既有缺口會被放大成全站規模的觀感問題 | 逐一補上 `list-style:none` + `summary::-webkit-details-marker{display:none}`，並訂為新增 `<details>` 的硬性規則（3.5） |
| 手機裁判 | 應修 | `.modal`／`.modal.sheet` 沒有扣掉 `--kb`（鍵盤高度），數字鍵盤／PIN／買入表單在小螢幕上容易被鍵盤蓋住標題或送出鈕 | `max-height` 計算式一併扣掉 `var(--kb, 0px)`（3.2） |
| 手機裁判 | 應修 | 「解鎖成功後呼叫 `ctx.refresh()`」與「要不要另外呼叫 `closeModal()`」語意含糊，不同 builder 可能各寫各的 | 明文規定：submit 成功只呼叫 `ctx.refresh()`，不要另外呼叫 `closeModal()`（1.2） |
| 理念裁判 | 應修 | `.wallet-grid` 若照抄 `.parent-profile-row` 的 `flex:0 0 min(78vw,240px)`，手機上一次只看得到一張錢包卡，違反「三個帳戶不合併、要可比較」 | 卡片寬度改窄（約 62vw）讓下一張卡片露出一截當作「還有更多」的視覺提示，外層加左右邊緣漸層遮罩＋一行「← 左右滑動看三個帳戶 →」提示文字，不用新增 JS 狀態（2.1、3.1） |
| 理念裁判 | 應修 | 拍板題 1（若選精簡成 3 個底部連結）會讓全站沒有任何常駐入口通往 `#/history`，`#/parent` Hub 完全沒有連過去的連結 | 不論拍板題 1 最終選哪個選項，都在 `#/parent` Hub 迷你頂欄旁加一個「🔍 所有紀錄」小連結，確保至少兩個入口（2.4） |

**擇優採納的「建議」**（其餘略）：較上月百分比的明確算法與降級規則（2.1／3.1）、家庭小專案 `<details>` 展開判準納入 `waiting` 狀態（2.1／5／6）、家庭小專案兩句理念文案移到 `<details>` 外常駐顯示（2.1／4／6）、折線圖摘要空狀態保留原本鼓勵語氣（2.1／4）、拍板題 2 拆成「底部 tab bar 的家長區連結」與「`.icon-lock-btn` 位置」兩題（8）、`.icon-lock-btn` 熱區與鄰近元素間距的真機覆核要求（3.3／3.7）、`100vh`→`100dvh` 漸進增強（3.1／3.6）、非 standalone 模式邊緣滑動返回手勢列入真機驗收（3.7）。未採納的建議：「拿掉最近紀錄從 6 筆砍到 3 筆」保留砍到 3 筆的原方案，但改用「reward 類型優先保留」的規則折衷（2.1）。

**技術基礎（已對照原始碼逐條核實，供 builder 放心引用；本輪新增查證項目標「（本輪新查）」）：**
- `docs/js/app.js` 第 106 行：`render()` 每次重繪都會無條件呼叫 `closeModal()`；第 112 行 `mount.replaceWith(next)` 把整個 `#app` 節點換掉。**（本輪新查）** 第 280 行 `gist.setRefreshHandler(() => { void refresh(); })`、第 198–204 行 `visibilitychange` 回前景時的每月獎勵檢查，都是會觸發這種「跟使用者操作無關」重繪的實際來源，不是理論風險。
- `docs/js/pin.js`：`unlockedPin` 是模組內記憶體變數，只在整頁重新載入時歸零；hash 內導覽不會清空，但解鎖狀態不受路由表保護，新路由必須自己判斷 `ctx.unlocked`。
- `docs/js/store.js` 第 87 行已有 `holding.priceUpdatedAt ?? holding.updatedAt` 的既有用法，可安全沿用；`profile.updatedAt` 在十餘處都會被觸發，不是「上次校正撲滿」的專屬時間戳。
- `docs/js/ui/parent.js` 第 18–47 行已有 `ui = { openDetails: new Set(), drafts: {}, editingPurchaseId, editingHarvestId, harvestHoldingId, destinationDreamId, purchaseOperationId, quoteMeta, ... }` 的模組內狀態物件——本規格第 5 節延用、擴充這個模式。
- `docs/js/ui/home.js` 第 17–39 行的頁面暫存變數，與第 572–617 行 `openAction()`/`openTransactionModal()`、第 807–823 行 `mount()` 裡「重繪之後把原本開著的 modal 補回來」的邏輯，**是本次所有新增 modal（解鎖、校正撲滿）必須照抄的範本**——這是本輪修訂新增的硬性規定，見 1.2、3.2、3.3。
- `docs/js/ui/history.js` 第 96–100 行已有 `lockPanel(pinStatus)` 函式，`dreams.js` 目前是內嵌 markup（第 164 行起的 `.parent-lock-card.dream-admin-lock`），沒有對應的獨立函式，需要抽出等價的一份。
- `docs/js/ui/common.js` 第 114–147 行的 `openModal()`/`closeModal()` 已經處理好 `modalSession`、`backdropInert`、Esc、焦點回復；本規格全程沿用，不新增第二套。**（本輪新查）** `openModal()` 第 117 行 `if (modalSession) closeModal();`——同一時間只能有一個 modal，這件事在「情境式解鎖」與「深連結展開」交錯時要注意，不要同時觸發兩個 `openModal()`。
- `docs/styles.css` **（本輪新查，用於核實兩份裁判報告的具體行號）**：`.site-shell`（第 91–96 行）是全站唯一帶 `overflow:hidden` 的頁面 shell，`.parent-shell`/`.dream-shell`/`.history-shell` 都沒有；`.hero-actions` 桌機基準樣式在第 432–436 行，650px 覆寫在第 2218–2219 行；`.status-toast` 的 `--kb` 用法在第 2528–2534 行；`.modal` 的 `max-height:calc(100vh - 44px)` 在第 1152–1161 行完全沒有用到 `--kb`；`.parent-profile-row` 手機斷點的單卡佔滿寫法（`flex:0 0 min(78vw,240px)`）在 650px 斷點區塊內；`.history-controls` 在 900px 斷點（第 2183 行）已經是 `grid-template-columns:1fr 1fr` 雙欄，但 650px 斷點（第 2399 行）又覆寫回 `display:block`，兩條規則互相打架；`.project-admin summary`（1254）、`.preset-admin summary`（1622）、`.parent-device-grid summary`（1903）、`.new-dream-card summary`（1967）四處都沒有 `summary::-webkit-details-marker{display:none}`，同檔案裡 `.garden-picker`／`.info-tip`／`.family-settings-panel`／`.investment-summary`／`.parent-guide`／`.harvest-summary`／`.harvest-history-panel`／`.reflection-history` 都有補這行，是既有的不一致。
- `docs/index.html` **（本輪新查）**：`#install-hint`、`#app`、`#toast-root`、`#modal-root` 是 `<body>` 的直接子節點，沒有被 `.site-shell` 的 `overflow:hidden` 影響——這證明「浮層／吐司放在 `#app` 外面」的模式在專案裡本來就存在且可行，但代表要新增同款的「貼底列根節點」就得改 `index.html`，超出 brief.md 明列的可改檔案範圍（`docs/js/ui/*.js`、`docs/js/ui/common.js`、`docs/js/app.js`、CSS），所以本規格改採「把 `.site-shell` 的 `overflow:hidden` 改成 `overflow-x:hidden`」這個影響面更小、不逾界的修法（見 0.1、3.1）。

---

## 1. 資訊架構

### 1.1 路由表（`docs/js/app.js`，唯一新增一條）

```js
const ROUTES = {
  "#/": { id: "home", load: () => import("./ui/home.js") },
  "#/dreams": { id: "dreams", load: () => import("./ui/dreams.js") },
  "#/history": { id: "history", load: () => import("./ui/history.js") },
  "#/parent": { id: "parent", load: () => import("./ui/parent.js") },
  "#/parent/investments": { id: "parent-investments", load: () => import("./ui/parent-investments.js") }, // 新增
  "#/setup": { id: "setup", module: setup },
};
```

`currentHash()`（app.js 第 23–27 行）用 `hash.split("?")[0]` 取 base，本來就支援 `#/parent/investments?open=purchase` 這種帶 query 的深連結，不需要改動比對邏輯。

### 1.2 家長操作碼：解鎖與上鎖在哪裡

- **設定／解鎖**：`#/parent` 頁最上方，未解鎖時渲染既有 `.parent-lock-card`（`parent.js` 第 170 行），輸入 4–8 碼操作碼，邏輯完全不動（`pin.setup()` / `pin.assert()`）。
- **上鎖**：目前程式沒有「主動上鎖」按鈕，`pin.lock()` 只在整頁重新載入才會清空 `unlockedPin`。本次不新增上鎖按鈕，但在 `#/parent` Hub 的迷你頂欄放一個「🔓 已解鎖」小字標示。
- **情境式解鎖（新）**：`#/dreams`、`#/history` 兩頁右上角各放一顆 32×32 的 `.icon-lock-btn`（未解鎖顯示 🔒、已解鎖顯示 🔓），點擊呼叫 `openModal()`，內容是既有 `.parent-lock-card` 表單 markup（`dreams.js` 沒有現成的獨立函式，抽出等價一份，內容照抄，不改欄位與 `pin.assert()` 呼叫）。

  **（本輪修訂，回應「擋下：新 modal 沒有重繪存活機制」）** 這個 lock modal **必須**照抄 `home.js` 的 `action`/`openModalKind` 模式，不能只是「呼叫一次 `openModal()`」：
  ```js
  // dreams.js / history.js 各自的模組作用域
  let lockModalOpen = false;   // 是否「應該」開著（不是 DOM 目前開不開）
  let lockPin = "";            // 已輸入但還沒送出的值，重繪後要回填
  let lockError = "";
  let lockModalKind = "";      // "" | "lock"，跟 common.isModalOpen() 分開判斷，理由同 home.js

  function openLockModal(ctx) {
    const dialog = openModal(lockPanel(ctx.pinStatus, lockPin, lockError), {
      labelledBy: "lock-dialog-title",
      onClose: () => { if (lockModalKind !== "lock") return; lockModalKind = ""; lockModalOpen = false; },
    });
    lockModalKind = "lock";
    dialog.addEventListener("input", (e) => { if (e.target.matches("[type=password]")) lockPin = e.target.value; });
    dialog.querySelector("form").addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        if (ctx.pinStatus === "setup") await pin.setup(lockPin); else await pin.assert(lockPin);
        lockModalOpen = false; lockPin = ""; lockError = "";
        ctx.refresh();   // ← 只呼叫這一行，見下段規定；render() 的 closeModal() 會自動把 modal 收掉
      } catch (caught) {
        lockError = errorMessage(caught, "操作碼不正確");
        // 重新畫錯誤訊息，不重開 modal（modal 還開著）
      }
    });
  }

  // mount(root, ctx) 裡：
  if (lockModalOpen && lockModalKind !== "lock") openLockModal(ctx);
  ```
  **明文規定（回應「應修：ctx.refresh() 與 closeModal() 語意含糊」）：submit 成功處理只呼叫 `ctx.refresh()`，不要另外呼叫 `closeModal()`——`ctx.refresh()` 會觸發 `app.js` 的 `render()`，其中第 106 行的無條件 `closeModal()` 已經涵蓋關閉這一步；若額外手動呼叫 `closeModal()` 再呼叫 `ctx.refresh()` 沒有壞處但多餘，若誤以為兩者互斥只呼叫其中一個會導致按鈕狀態或畫面不同步，一律照上面骨架的順序寫。**

  解鎖成功後 `ctx.refresh()` 會讓頁面重新 `render()`，家長專屬按鈕依 `ctx.unlocked` 條件渲染出來（沿用 `dreams.js`／`history.js` 現有的 `unlocked` 條件渲染邏輯，只是觸發位置從常駐卡片改成 modal）。

- **新路由的解鎖保護**：`#/parent/investments` 的 `render(ctx)` 開頭第一行：
  ```js
  if (!ctx.unlocked) return html`${common.stateGate("請先從家長區解鎖", () => ctx.navigate("#/parent"))}`;
  ```

### 1.3 底部固定分頁列（取代頂部四連結文字導覽）

`common.js` 的 `primaryNav(active)`（第 25–31 行）函式本體不用改，只在 `styles.css` 的 650px 手機斷點把 `.primary-nav` 改成 `position:fixed` 貼底（見 3.1 節），連帶讓四個頁面現有的 `.topbar`／`.parent-topbar`（原本 132px）自動變矮到約 60–70px，不需要改任何 HTML。

是否要把 4 個連結精簡成 3 個、以及「🔑 家長」入口是否該留在拇指區常駐列，列為第 8 節拍板題（已拆成題 1 與題 2，見該節）。

### 1.4 頁面清單與用途

| 路由 | 用途 | 使用者 |
|---|---|---|
| `#/` | 孩子每天打開的主畫面：記帳、看三個錢包、看小島花園、看最近紀錄 | 孩子 |
| `#/dreams` | 夢想罐進度（常看）＋每月回顧（每月一次），兩個分頁 | 孩子為主，家長偶爾編輯既有夢想罐 |
| `#/history` | 查帳：搜尋、篩選、分頁列表 | 孩子與家長都會查，家長多一組編輯/刪除權限 |
| `#/parent` | 家長解鎖後的收件匣：待辦、快速動作、比例設定、孩子資料、投資入口、備份、指南 | 僅家長（PIN 保護） |
| `#/parent/investments` | 真實買入、持股、買入紀錄、過年收成 | 僅家長（PIN 保護，見 1.2） |

---

## 2. 逐頁規格

### 2.1 `#/` 孩子首頁

**由上到下（捲動內容）：**

| 順序 | 區塊 | 內容／互動 | 估高(375px) | 沿用/新增 | 空狀態 |
|---|---|---|---|---|---|
| 1 | 迷你頂欄 `.topbar` | 品牌小字＋`profileChips()` 孩子切換 | ~64px | 沿用 | — |
| 2 | `.hero-copy`（精簡） | eyebrow＋h1＋`.hero-practice` 比例列，原文字不變。**`.hero-actions`（兩顆記帳按鈕）的 markup 保留不動**，只在 ≤650px 用 CSS 隱藏（見「本輪修訂」與 3.1 節）——**不是刪除**，是「桌機/iPad 用這組、手機用貼底 `.record-bar` 那組」的顯示切換，兩組按鈕的 `data-action="open-allowance"/"open-spend"` 完全相同，`home.js` 的 `onRootClick` 事件委派本來就是找 `closest("[data-action]")`，不需要新增任何 JS 判斷 | ~150px（手機上按鈕 `display:none` 不佔高度） | 沿用既有 markup，CSS 新增顯示切換 | — |
| 3 | `.wallet-grid`（橫向捲動） | 三張 `moneyCard()` 原樣，caption 文字完全不改。**（回應理念裁判應修）** 手機斷點卡片寬度改窄（約 `min(62vw, 210px)`，不是照抄 `.parent-profile-row` 的 78vw），讓下一張卡片自然露出一截當作「還有更多」的視覺提示；外層加左右邊緣的漸層遮罩（純 CSS `mask-image`，不用 JS 算捲動位置）；卡片列表上方加一行 8px 灰字提示「← 左右滑動看三個帳戶 →」。取捨說明：仍然是橫向捲動（不是三欄硬塞進 375px，那樣 caption 與按鈕文字會擠爆），但透過「露出一截＋邊緣遮罩＋文字提示」把「只看得到一張卡、不知道還有兩張」的問題壓到最低，且緊接在下方的花園總資產文字（`futureValue=爸媽銀行+ETF`）本身就同時涵蓋卡 2＋卡 3 的數字，天然補足一部分「可比較」的需求，不是三張卡完全孤立 | ~172px（含提示行） | 沿用 `moneyCard()`；CSS 新增橫向捲動＋遮罩＋提示行 | — |
| 4 | 小島花園 `islandGarden()` | 縮小版場景＋樹種選擇 `<details class="garden-picker">` 預設收合；「◯◯已經存給未來 X → 現在成長為 Y」文案原樣保留，`futureValue`／`futurePrincipal` 參數與運算完全不動 | ~220px | 沿用，CSS 調整尺寸＋`<details>`預設關閉 | — |
| 5 | 折線圖收合摘要 | `assetGrowthChart()` 包一層 `<details>`，summary 顯示「目前總資產 {total}，較上月 {±X}%」。**（回應理念裁判「建議」：明確定義「較上月」）** 算法：取 `assetTimeline()` 回傳的取樣陣列（`home.js` 第 59–82 行既有函式，最多 10 個取樣點，超過 10 個月會做 `Math.round` 取樣），比較**陣列最後兩個點**（`points[len-1].value` 對 `points[len-2].value`）算百分比；陣列長度 < 2（帳號剛開始用，只有一個月資料）時**不顯示百分比**，summary 降級成「目前總資產 {total}」。這是對既有取樣結果的直接比較，不新增任何運算邏輯，取樣後失真的風險跟原本折線圖本身一致，不是本次新增的問題。展開才看完整折線。**拿掉**卡片內原本重複的「夢想罐進度」小清單，改成一行連結去 `#/dreams`；**（回應理念裁判「建議」：保留原本零夢想罐時的鼓勵語氣）** 這行連結文字依 `activeDreams.length` 動態決定：有夢想罐時顯示「查看夢想進度 →」，`activeDreams.length === 0` 時改顯示「還沒有夢想，去放進一個 →」（沿用原 `growth-dream-empty` 空狀態的語氣，只是從一張卡壓成一行連結） | 收合 ~70px／展開 ~420px | 沿用 `assetGrowthChart()`，小改內部 markup | 見上（零夢想罐時的連結文案） |
| 6 | 最近紀錄 | `.activity-card` 時間軸。**（回應理念裁判「建議」：reward 類紀錄不被擠出）** 邏輯改成「取最近 3 筆；若當月有一筆 `kind==="reward"` 的紀錄但不在這 3 筆裡，把它換進第 3 格（原本第 3 筆往下讓路，不會整個消失，因為「查看全部紀錄→」本來就在）」，不是單純的 `slice(0, 3)`。函式簽名：`recentActivities(activities, 3)`，純前端陣列運算，不動 `store` | ~130px | 沿用，改篩選邏輯 | 無紀錄時顯示「還沒有紀錄，記第一筆看看」小字 |
| 7 | 家庭小專案（收合） | `.projects-section` 整段包進 `<details>`，summary「🧩 家庭小專案・{open+claimed+waiting 數} 個待處理」。**（回應理念裁判「建議」：waiting 狀態要算進展開判準）** `open` 屬性的預設值＝`state.projects.some(p => ["open","claimed","waiting"].includes(p.status))`——只要有任何一個專案處於這三種「非 completed」狀態就預設展開，不限定「孩子能互動」；理由：孩子送出專案後進入 `waiting`，這時孩子不能再操作它，但孩子仍然需要在首頁直接看到自己那筆「⌛ 等待家長在家長專區確認」的狀態，不用多點一次。**（回應理念裁判「建議」：兩句理念文案移出收合區）** 「只有家長事前約定、超出日常責任的完整任務才會出現在這裡」與「完成後才發放，報酬一樣先存 {savingsRate}%」這兩句**移到 `<details>` 外面、緊貼在 summary 下方，一律常駐可見，不隨收合狀態隱藏**（不用展開就看得到，比放進 summary 內部更乾淨，不會讓 summary 那一行過長）；`<details>` 只包住 `.project-grid` 卡片列表本身 | 收合 ~90px（多了常駐兩句文案的高度）／展開 ~730px | 沿用 `.project-grid` 內容，外層加 `<details>`，兩句文案搬到 `<details>` 外 | 沒有任何專案時 summary 顯示「目前沒有開放的小專案」，且不開放展開（或展開後顯示一行說明） |
| 8 | 我們家的約定（不收合） | 標題＋副標＋四條規則，全部保持展開，只用 CSS 把 `.rule-list` 在手機斷點改成 2×2 grid 壓縮高度 | ~380px | 沿用 markup，CSS 新增 2×2 grid | — |
| 9 | footer | 版權小字 | ~50px | 沿用 | — |

**貼底固定（不佔捲動高度）：**
- `.record-bar`（~64px）：兩顆等寬按鈕，`data-action="open-allowance"`／`data-action="open-spend"`，跟 `.hero-actions` 裡的按鈕共用同一組 `data-action`（不是重複實作，是同一組觸發邏輯的兩份 markup，見上方第 2 項與 3.1 節），只在 ≤650px 顯示；>650px 時 `.record-bar { display:none }`，改由 `.hero-actions` 承接。
- `.primary-nav`（貼底 tab bar，~56px + safe-area）。

估高總計（捲動內容）：64+150+172+220+70+130+90+380+50 ≈ **1326px（約 1.6 屏）**；對比現況 4595px（5.7 屏）。

**ASCII 線框圖（375×812）：**

```
┌─────────────────────────────────────┐ 0
│ ¢小小理財島      (大寶)(二寶)(三寶)▸ │ 64  迷你頂欄
├─────────────────────────────────────┤
│ 大寶的理財小基地                      │
│ 大寶的錢，正在慢慢長大。               │
│ 35%先留給未來   65%自己做選擇          │ 150 hero-copy（按鈕手機隱藏）
├─────────────────────────────────────┤
│  ← 左右滑動看三個帳戶 →               │
│ ◀ 🐷撲滿$320  🏦爸媽銀行$1050▶(露一截)│ 172 wallet-grid 橫向捲動＋邊緣遮罩
├─────────────────────────────────────┤
│         🌳🌲🌱 （小島花園縮圖）        │
│   大寶已經存給未來$1050→現在成長$1910 │ 220 花園（樹種選擇收合）
│         ▸ 選擇樹種                    │
├─────────────────────────────────────┤
│ ▸ 目前總資產$2230，較上月+4%（收合）  │ 70  折線圖摘要
├─────────────────────────────────────┤
│ 最近紀錄                  查看全部→   │
│ 🐷+50零用錢 9/6 ｜💸-30買貼紙 9/5     │ 130 最近3筆（reward優先保留）
│ 🏦+20多存核准 9/3                     │
├─────────────────────────────────────┤
│ 只有事前約定的完整任務才會出現在這裡    │
│ 完成後才發放，報酬一樣先存30%（常駐）  │
│ ▸ 🧩 家庭小專案・2 個待處理（收合）    │ 90
├─────────────────────────────────────┤
│ 錢是用來練習選擇，不是拿來考試。       │
│ 記不清楚時，我們一起補帳…              │
│ [01先存再花][02想要自己買]            │ 380 我們家的約定（不收合，2×2）
│ [03需要爸媽負責][04一起記一起想]       │
├─────────────────────────────────────┤
│      © 小小理財島 · 讓好習慣慢慢長大   │ 50
├───────────────────────────────────－－┤
│ [ 🐷 記一筆零用錢 ]  [ 💸 記一筆花費 ] │ 64  貼底固定（≤650px）
├─────────────────────────────────────┤
│ 孩子首頁    夢想與回顧  所有紀錄  家長區│ 56  貼底 tab bar
└─────────────────────────────────────┘ 812
```

---

### 2.2 `#/dreams` 夢想與回顧（分頁重構）

（本節與上一版相同，未受本輪批評指出的缺陷影響，保留原規格。）

**結構：原生 `<details name="dreamtab">` 互斥手風琴**（是否改成 8 行 JS 版本見第 8 節拍板題）。

**共用頂部：**

| 順序 | 區塊 | 內容 | 估高 |
|---|---|---|---|
| 1 | 迷你頂欄 | 品牌＋孩子切換＋右上角 `.icon-lock-btn`（🔒/🔓，情境式解鎖，見 1.2） | 64px |
| 2 | 理念一行句 | 「先問：這筆錢什麼時候要用？」單行常駐，`infoTip()` 內放第二句 | 40px |
| 3 | 分頁列 | `[🎯 夢想罐]` `[📝 每月回顧]`，`<details name="dreamtab">` | 44px |

**「夢想罐」分頁（預設 `open`）：**

| 順序 | 區塊 | 內容 | 估高 | 沿用/新增 |
|---|---|---|---|---|
| 4 | 目前夢想進度卡 | 短期／長期兩張 `.dream-card`；旁邊固定保留「撲滿金額改變時，這裡會自動更新．不會另外扣款」，緊貼短期進度卡，不隨任何 details 收合 | ~260px | 沿用 |
| 5 | 新增下一個夢想 | `<details class="new-dream-card">` 預設不開（除非 `!jars.length \|\| editingId`） | 收合 ~48px | 沿用邏輯，改 summary 文案 |
| 6 | 排隊中清單 | `.dream-list-panel` | 依筆數，~150px | 沿用 |
| 7 | 已完成夢想罐（收合） | `<details>` 包住 `.completed-dream-grid`，summary「查看已完成的 {N} 個夢想」 | 收合 44px | 沿用內容，外層加 `<details>` |

**「每月回顧」分頁：**

| 順序 | 區塊 | 內容 | 估高 | 沿用/新增 |
|---|---|---|---|---|
| 4b | 月份切換 | `.reflection-month-picker`，箭頭按鈕從 36px 放大到 **44×44px** | 60px | CSS 調整既有元件 |
| 5b | 三個數字摘要 | 沿用 | 70px | 沿用 |
| 6b | 三題 textarea＋儲存 | 沿用，`saveReflection()` 邏輯不動 | ~420px | 沿用 |

家長編輯／刪除／完成／啟用夢想：邏輯不變，只改變解鎖入口（見 1.2）。

估高（夢想罐分頁）：64+40+44+260+48+150+44 ≈ **650px（約 0.8 屏）**；回顧分頁：64+40+44+60+70+420 ≈ **698px（約 0.9 屏）**。對比現況 3184px（3.9 屏）。

（ASCII 線框圖同上一版，未變動，故略去重複。）

---

### 2.3 `#/history` 所有紀錄

| 順序 | 區塊 | 內容 | 估高 | 沿用/新增 |
|---|---|---|---|---|
| 1 | 迷你頂欄 | 品牌，靠 `.primary-nav` 貼底自動變矮 | 64px | 沿用 |
| 2 | hero 精簡一行 | 「◯◯的錢，每一步都有故事。」單行＋右上角 `.icon-lock-btn` | 40px | 精簡既有 markup |
| 3 | 孩子切換列 | `.parent-profile-row`，含各自筆數，橫向捲動 | 74px | 沿用 |
| 4 | 篩選一列 | 搜尋框＋類型下拉並排一行：**（回應手機裁判本輪新查的規則衝突）** 刪掉 `styles.css` 第 2399–2401 行 `.history-controls` 在 650px 斷點的 `display:block` 覆寫，讓第 2183 行 900px 斷點原本就有的 `grid-template-columns:1fr 1fr` 延續到手機；家長解鎖卡（原 `.history-lock`）整個移除，改用第 2 項的 `.icon-lock-btn` | ~100px | CSS：刪一條覆寫規則；HTML：`lockPanel()` 不再內嵌，改進 modal |
| 5 | 月份分組列表 | view 層依 `entryDate` 年月 `reduce` 分組，`<h3 class="history-month-header">2026年9月</h3>`（`position:sticky;top:0`），純前端分組，不動 `store.getActivitiesPage` | 依筆數 | 新增分組邏輯＋新 class |
| 6 | 每列編輯／刪除鈕 | `activityRow()` 改成僅 `pinStatus === "unlocked"` 才產出這段 DOM | 未解鎖時每列少 ~44px | 小改 `activityRow()` |
| 7 | 載入更多 | `PAGE_SIZE` 從 40 改成 16（`history.js` 第 9 行） | — | 一行常數改動 |

情境式解鎖的 modal（`.icon-lock-btn`）同 1.2 節的統一模式，`history.js` 已有 `lockPanel(pinStatus)` 函式（第 96–100 行），直接沿用其表單片段包進 `openModal()`，套用 1.2 節的 `lockModalOpen`/`lockModalKind` 存活模式。

（ASCII 線框圖同上一版。）

---

### 2.4 `#/parent` 家長首屏（Hub，解鎖後）

**未解鎖狀態**：維持現行 `.parent-lock-card` 全螢幕解鎖表單，不動。

**已解鎖狀態，由上到下：**

| 順序 | 區塊 | 內容 | 估高 | 沿用/新增 | 空狀態 |
|---|---|---|---|---|---|
| 1 | 迷你頂欄 | 品牌＋孩子切換＋🔓已解鎖小字**＋一個「🔍 所有紀錄」小連結**（連到 `#/history`） | 64px | 沿用＋新增一個連結 | — |
| 1.5 | **（本輪新增，回應理念裁判應修）家長端查帳入口** | 不論第 8 節拍板題 1 最終選哪個選項（底部 tab bar 留 4 個或精簡成 3 個），`#/parent` Hub 都要有**至少一個**明確連到 `#/history` 的連結——優先做法是放進上一列迷你頂欄（「🔍 所有紀錄」小字連結），不需要額外佔一整個區塊高度；若底部 tab bar 選項 A（維持 4 個連結）則這個入口是「錦上添花的第二入口」，若選項 B（精簡成 3 個）則這個入口是「唯一常駐入口」，兩種情況下都不能沒有 | 併入第 1 項高度 | 新增 | — |
| 2 | 待辦收件匣 | `pendingSavingsTransfers`＋`waitingProjects`，各一行「誰・多少・[核准][不執行]」一鍵完成，解鎖後第一個實質內容 | 有待辦每項 ~70px | 沿用既有邏輯與 markup，搬移位置 | 「這個月都核對過了 ✓」一行正向文案 |
| 3 | 快速動作列 | 三顆等寬按鈕「記買入」「記收成」「校正撲滿」。前兩顆導向 `#/parent/investments?open=purchase` / `?open=harvest`；「校正撲滿」呼叫 `openModal()`，內容是共用函式 `piggyCorrectionModalBody(profile)`（同一段 markup／邏輯同時被本頁與第 5 項的 `.profile-editor-panel` 呼叫）。**（回應手機裁判擋下：新 modal 要照抄存活模式）** 這個「校正撲滿」modal 跟 1.2 節的 lock modal 一樣，**必須**用 module-scope 旗標（`correctionOpen`/`correctionDraft`/`correctionModalKind`）記住「該不該開」與「已輸入的金額」，`mount()` 裡加對應的重開檢查；送出成功只呼叫 `ctx.refresh()`，不手動呼叫 `closeModal()`（規則同 1.2） | 60px | 3 顆按鈕新增；表單內容沿用既有欄位 | — |
| 4 | 預先儲蓄比例 | `.savings-inline-panel` stepper，沿用不動 | 90px | 沿用 | — |
| 5 | 孩子資料編輯 | `<details class="profile-editor-panel">` 預設收合，內容含名字/照片/新增移除/撲滿校正（呼叫同一個 `piggyCorrectionModalBody`） | 收合 50px | 沿用 | — |
| 6 | 投資入口卡 | 一行摘要：「📈 投資 · {持股數}檔持股 · 上次更新{`holding.priceUpdatedAt ?? holding.updatedAt`}」＋「前往投資管理 →」連結 `#/parent/investments` | 90px | 新增摘要卡，讀既有欄位 | 0 檔持股時顯示「尚未記錄任何持股」 |
| 7 | 家庭小專案（管理） | 待確認清單已在第 2 項處理，這裡只留「目前專案列表」＋「新增專案」`<details>`（收合）。新增專案表單：報酬欄位預設值 **50**、排序欄位預設值 **目前清單長度+1** | 收合 ~260px | 沿用 markup，新增兩個欄位預設值 | — |
| 8 | 資料與備份 | `.parent-device-panel` 既有四個 `<details>`，維持收合 | ~450px | 沿用 | — |
| 9 | 理念與操作指南 | `guideMarkup()` 移到最後一個 `<details>`；`pinStatus === "setup"` 時預設 `open` 並置頂，其餘一律收合 | 收合 44px | 沿用內容，搬移位置＋加條件 | — |
| 10 | footer | 沿用 | 50px | 沿用 | — |

估高（無待辦、一切收合）：64+60+90+50+90+260+450+44+50 ≈ **1158px（約 1.4 屏）**。對比現況收合 3099px（3.8 屏）。

**ASCII 線框圖：**

```
┌─────────────────────────────────┐
│ ¢小小理財島 家長區 🙂大寶▾ 🔓 🔍所有紀錄│ 64
├─────────────────────────────────┤
│ 大寶想多存 $50    [核准][不執行] │ 70 待辦（有才顯示）
├─────────────────────────────────┤
│ [記買入] [記收成] [校正撲滿]     │ 60 快速動作
├─────────────────────────────────┤
│ 預先儲蓄比例  ◀ 35% ▶  [儲存]   │ 90
├─────────────────────────────────┤
│ ▸ 孩子資料編輯（收合）           │ 50
├─────────────────────────────────┤
│ 📈 投資・1檔持股・3天前更新  →  │ 90
├─────────────────────────────────┤
│ ▸ 家庭小專案管理（收合）         │ 260（往下滑）
├─────────────────────────────────┤
│ ▸ 資料與備份（收合）             │ 450
├─────────────────────────────────┤
│ ▸ 理念與操作指南（收合）         │ 44
└─────────────────────────────────┘
┌────┬──────┬──────┬────┐
│首頁│夢想與回顧│所有紀錄│家長│ ← 家長 active
└────┴──────┴──────┴────┘
```

#### 2.4.1 `#/parent/investments`（新路由）

`parent.js` 現有的 `investment-layout` 整段（約第 248–424 行）原樣剪貼到新檔案 `docs/js/ui/parent-investments.js`，只改：

| 順序 | 區塊 | 內容 | 沿用/新增 |
|---|---|---|---|
| 1 | 返回列 | `.back-home`「‹ 返回家長區」連結 `#/parent`；`primaryNav("parent")` 仍顯示「家長區」為 active | 沿用既有 class |
| 2 | 買入表單 | 常用標的選擇＋買入欄位，單一持股家庭（`holdings.length===1`）直接帶入代號/名稱/類型；常用標的管理維持收合 | 沿用既有 `holdings.length===1` 條件 |
| 3 | 持股卡 | 單一持股時去掉列表感，直接一張卡＋市值輸入欄；新增一行「上次更新 {N} 天前」（用 `holding.priceUpdatedAt ?? holding.updatedAt`） | 沿用 `.holding-panel`，加一行摘要 |
| 4 | 買入紀錄 | 既有列表＋編輯／撤銷 | 沿用 |
| 5 | 過年投資收成 | `<details id="harvest">` 的 `open` 屬性依 `[0, 1].includes(new Date().getMonth())`（陽曆 1、2 月）預設展開；其餘月份收合，summary 顯示「上次收成：{最近一筆 harvest 的 saleDate}」或「今年還沒收成」。家長手動收合過一次後改用 `harvestManuallyToggled` 旗標記住手動選擇，不再被月份判斷蓋回。單一持股時「選擇賣出標的」下拉改成純文字確認 | 新增月份判斷＋既有表單邏輯不動 |
| 6 | 深連結展開 | `mount()` 讀 `location.hash` 的 `?open=purchase` / `?open=harvest`，對應把該區塊 `<details>` 設 `open=true` 並 `scrollIntoView`；買入表單不是 `<details>`，用 `scrollIntoView` + focus 第一個欄位 | 新增少量 mount 邏輯 |

**解鎖保護**：`render(ctx)` 開頭 `if (!ctx.unlocked) return ...`（見 1.2）。

---

## 3. 共用元件規格（一位 builder 先做這層）

### 3.1 底部固定分頁列與貼底列（`.primary-nav`／`.record-bar` 改造，本節為本輪修訂重點）

**先解決容器風險（回應手機裁判擋下 1）**：`.site-shell` 目前是 `min-height:100vh; overflow:hidden;`（第 91–96 行），是全站唯一帶這個屬性的頁面 shell，恰好是新增兩層貼底固定元素唯一會落腳的容器。改成只保留水平方向的防禦：

```css
.site-shell {
  min-height: 100vh;
  min-height: 100dvh;   /* 漸進增強：支援的瀏覽器拿到準確高度，不支援的忽略這行、吃回上一行的 100vh */
  overflow-x: hidden;   /* 原本 overflow:hidden 只是防止意外的水平捲軸；拿掉垂直方向，避免 WebKit
                            「fixed 元素被 overflow:hidden 祖先裁掉」這類已知風險（見 0.1、3.7） */
  background: var(--theme-page, var(--cream));
  transition: background-color .28s ease, color .28s ease;
}
```

**统一的 `--dock` 變數（回應手機裁判應修：body/shell padding-bottom 疊加、status-toast 位置沒算貼底列）**：不用 `body{padding-bottom:64px}` 這種會跟既有 shell padding 疊加的通用規則，改成單一真相來源——`app.js` 在每次 `render()` 換掉 `#app` 之後，依剛渲染出的頁面判斷這頁有幾層貼底固定元素，寫進 `<html data-dock="...">`：

```js
// app.js 的 render()，在 mount.replaceWith(next) 之後、updateInstallHint() 之前加一行：
const dockKind = next.querySelector(".record-bar") ? "record" : next.querySelector(".primary-nav") ? "nav" : "none";
document.documentElement.dataset.dock = dockKind;
```

```css
:root { --dock: env(safe-area-inset-bottom, 0px); }  /* 沒有貼底列的頁面（如 #/setup）：只留安全區 */
@media (max-width: 650px) {
  :root[data-dock="nav"]    { --dock: calc(56px + env(safe-area-inset-bottom, 0px)); }   /* 只有 tab bar 的三頁 */
  :root[data-dock="record"] { --dock: calc(120px + env(safe-area-inset-bottom, 0px)); }  /* 首頁：record-bar + tab bar */

  .primary-nav {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 40;
    display: flex; width: 100%;
    background: var(--paper); border-top: 1px solid var(--line);
    padding: 4px 6px calc(6px + env(safe-area-inset-bottom));
  }
  .primary-nav a {
    flex: 1; display: flex; flex-direction: column; align-items: center;
    gap: 2px; min-height: 52px; justify-content: center; font-size: 10px;
  }

  .record-bar {
    position: fixed; left: 0; right: 0; z-index: 39;
    bottom: calc(56px + env(safe-area-inset-bottom));  /* 貼在 tab-bar 正上方 */
    display: flex; gap: 8px; padding: 8px 12px;
    background: var(--paper); border-top: 1px solid var(--line);
  }
  .record-bar button { flex: 1; min-height: 48px; border-radius: 16px; font-weight: 900; }

  /* 唯一的 padding-bottom 來源：四個 shell 全部改用 --dock，不再各自寫死 80px，
     也不再疊加通用 body 規則——這條直接取代舊版 .parent-shell/.dream-shell/.history-shell 的 padding-bottom:80px */
  .site-shell,
  .parent-shell,
  .dream-shell,
  .history-shell { padding-bottom: var(--dock); }
}
```

**status-toast 一併吃到 `--dock`（回應手機裁判應修）**：

```css
.status-toast {
  /* 原本：bottom: calc(env(safe-area-inset-bottom, 0px) + 20px + var(--kb, 0px));
     --dock 已經內含 env(safe-area-inset-bottom)，不要再加一次，否則雙重計算 */
  bottom: calc(20px + var(--kb, 0px) + var(--dock, env(safe-area-inset-bottom, 0px)));
}
```

**桌機／iPad 的 `.hero-actions` 與手機的 `.record-bar` 顯示切換（回應理念裁判擋下）**：

```css
.record-bar { display: none; }  /* 桌機／iPad 預設不出現：.hero-actions 已經有自己的桌機基準樣式（styles.css 432 行），不用動 */

@media (max-width: 650px) {
  .hero-actions { display: none; }   /* 手機隱藏 hero 裡的按鈕，改用貼底列 */
  .record-bar { display: flex; }     /* 上面已定義 position/gap/padding，這裡只切換可見性 */
}
```

**`.wallet-grid` 手機斷點（回應理念裁判應修：不要照抄 78vw 單卡佔滿）**：

```css
@media (max-width: 650px) {
  .wallet-grid {
    display: flex; overflow-x: auto; gap: 10px; padding: 4px 4px 8px;
    scroll-snap-type: x mandatory; scrollbar-width: none;
    -webkit-mask-image: linear-gradient(to right, transparent, black 16px, black calc(100% - 16px), transparent);
    mask-image: linear-gradient(to right, transparent, black 16px, black calc(100% - 16px), transparent);
  }
  .wallet-grid::-webkit-scrollbar { display: none; }
  .wallet-grid > .money-card { flex: 0 0 min(62vw, 210px); scroll-snap-align: start; }
  .wallet-scroll-hint { display: block; margin: 0 0 6px; font-size: 11px; color: var(--muted); text-align: center; }
}
.wallet-scroll-hint { display: none; }  /* 桌機不需要這行提示，三張卡本來就並排 */
```

`home.js` 在 `.wallet-grid` 前面加一行 `<p class="wallet-scroll-hint">← 左右滑動看三個帳戶 →</p>`（純文字，不影響桌機版面，桌機用上面的規則隱藏）。

任何新增的貼底固定元素，一律要用 `--dock` 檢查該頁容器的 `padding-bottom` 是否等於「所有貼底固定元素高度總和 + `env(safe-area-inset-bottom)`」——這是工程可行裁判與手機裁判都點名的具體風險，第 3.7 節列為真機驗收項目。

### 3.2 浮層：不建新 sheet 系統，擴充既有 `openModal`

`common.js` 的 `openModal()`（第 114–147 行）已經處理好 `modalSession`、`backdropInert(true/false)`、Esc 關閉、焦點回復、`app.js` 每次重繪自動 `closeModal()` 的完整生命週期。**本規格全部沿用，不新增 `openSheet`/`closeSheet`。**

**（回應手機裁判擋下：新 modal 要照抄存活模式）任何本規格新增的 modal 表單（情境式解鎖、校正撲滿），一律套用 1.2 節給出的骨架**：module-scope 旗標記住「是否該開」＋「已輸入但未送出的值」，`mount()` 檢查「該開卻沒開」就重新呼叫對應的 `openXxxModal()` 並回填欄位值，submit 成功只呼叫 `ctx.refresh()`。這不是選配，是本規格對這兩個新流程的硬性要求，理由：這兩個流程都會停留較長時間輸入財務數字或密碼，暴露在「背景重繪打斷輸入」的風險比原本的記帳 modal 更高（`gist.setRefreshHandler`／`visibilitychange` 每月獎勵檢查都可能在使用者輸入到一半時觸發）。

若未來某個表單想要「從底部滑入」的視覺效果，做法是：

```js
openModal(formHtml, { className: "sheet" });
```

```css
.modal.sheet {
  align-self: flex-end; width: 100%; max-width: 100%;
  border-radius: 20px 20px 0 0; max-height: calc(88vh - var(--kb, 0px));
}
.modal.sheet::before {
  content: ""; display: block; width: 36px; height: 4px; border-radius: 2px;
  background: var(--line); margin: 8px auto 4px;
}
```

**（回應手機裁判應修：`.modal` 沒有扣掉鍵盤高度）** 同時修正既有 `.modal` 本身（不是只加在新元件上）：

```css
.modal {
  position: relative;
  width: min(100%, 480px);
  max-height: calc(100vh - 44px - var(--kb, 0px));  /* 原本只有 100vh - 44px，沒有扣鍵盤高度 */
  overflow-y: auto;
  padding: 36px;
  border-radius: 28px;
  background: var(--paper);
  box-shadow: 0 28px 80px rgba(8,33,28,.27);
}
```

不做真正的拖曳手勢（呼應提案3「不寫新的拖曳互動邏輯」的最小改動紀律），關閉一律用既有右上角 `.modal-close`、點背景遮罩、或 Esc。本次四個頁面的規格都不需要用到 `.modal.sheet` 變體，先定義起來是為了未來延用同一套生命週期。

### 3.3 情境式解鎖圖示 `.icon-lock-btn`

```css
.icon-lock-btn {
  position: relative; width: 32px; height: 32px; border-radius: 50%;
  border: 1px solid var(--line); background: var(--paper);
  display: flex; align-items: center; justify-content: center; font-size: 15px;
}
.icon-lock-btn::before { content: ""; position: absolute; inset: -6px; } /* 擴大命中區到 44×44 */
```

點擊行為：見 1.2 節的 `openLockModal(ctx)` 骨架。`lockPanel()` 沿用 `history.js` 第 96–100 行既有函式；`dreams.js` 沒有對應函式，抽出等價的一份，內容照抄 `.parent-lock-card` 的表單欄位，不改欄位與驗證邏輯。

**（回應手機裁判「建議」：熱區與鄰近元素可能重疊）** `.icon-lock-btn` 跟左右相鄰的 `profileChips()`／品牌文字之間，至少要留 12px 的實際間距（不是視覺間距，是扣掉 `::before` 擴大熱區後的間距），列入 3.7 節真機驗收項目，若在 iPhone SE（375px 最窄機型）量出來 < 12px，改用 `padding` 撐大可見尺寸本身、縮小 `inset` 到 -4px，而不是保持 -6px 硬擠。

### 3.4 月份分組 sticky 標頭

```css
.history-month-header {
  position: sticky; top: 0; z-index: 5;
  background: var(--cream); padding: 6px 4px; font-size: 12px; font-weight: 900; color: var(--muted);
}
```

view 層純函式（`history.js` 新增）：

```js
function groupByMonth(activities) {
  const groups = [];
  let currentKey = "";
  for (const item of activities) {
    const key = item.entryDate.slice(0, 7); // "2026-09"
    if (key !== currentKey) { groups.push({ key, items: [] }); currentKey = key; }
    groups[groups.length - 1].items.push(item);
  }
  return groups;
}
```

不動 `store.getActivitiesPage`，純前端 `reduce`／分組。

### 3.5 Safari 隱藏 `<details>` 原生三角形（回應手機裁判應修，本輪新增獨立小節）

`docs/styles.css` 裡大多數既有 `<details>` 都補了 `summary::-webkit-details-marker{display:none}`，但下列四處目前沒有補（Safari 上會同時看到原生三角形跟手畫的 `▸` 符號），本次連同新增的折疊區塊一併修：

```css
/* 補齊既有缺口，逐一在對應規則加上這兩行 */
.project-admin summary,
.preset-admin summary,
.parent-device-grid summary,
.new-dream-card summary {
  list-style: none;
}
.project-admin summary::-webkit-details-marker,
.preset-admin summary::-webkit-details-marker,
.parent-device-grid summary::-webkit-details-marker,
.new-dream-card summary::-webkit-details-marker {
  display: none;
}
```

**硬性規則：本規格新增的每一個 `<details>`（折線圖摘要、家庭小專案外層、已完成夢想罐、投資頁的深連結展開等）一律要有 `list-style:none` + `summary::-webkit-details-marker{display:none}`，不能照抄舊碼裡缺這兩行的那幾個。**

### 3.6 CSS 自訂屬性一覽（本輪新增，統整 `--kb`／`--dock` 的分工）

| 變數 | 誰設定 | 用途 |
|---|---|---|
| `--kb` | `app.js` 的 `setupKeyboardLift()`（既有，第 247–260 行），用 `visualViewport` 量鍵盤高度 | `.status-toast`、`.modal`、`.modal.sheet` 的位置／高度計算要扣掉鍵盤 |
| `--dock`（新） | `app.js` 的 `render()`，依當頁渲染出的固定元素種類設 `data-dock` | `.status-toast` 的 `bottom`、四個 shell 的 `padding-bottom`，統一算「貼底固定列吃掉多少空間」 |

兩者不會互相覆蓋（分別掛在不同用途），`.status-toast` 是唯一同時用到兩者的元件。

### 3.7 真機驗收清單（上線前必須實測，讀原始碼無法百分之百確認）

本規格多處修法是「讀原始碼＋核對 CSS 規則後判斷風險已排除」，但兩位裁判都指出部分行為只有真機（尤其加入主畫面的 standalone 模式）才能百分之百確認。上線前至少覆核：

1. **貼底 `.record-bar`／`.primary-nav`（首頁）**：捲到頁面最頂、捲到最底、鍵盤彈出時、加入主畫面 standalone 模式，四種情境下貼底列是否穩定存在、沒有被裁切或閃爍（對應 0.1／3.1 的 `.site-shell` overflow 修法）。
2. **新增的 lock modal／校正撲滿 modal**：輸入到一半時觸發一次背景重繪（可用「切到背景 10 秒以上再切回」模擬 `visibilitychange` 檢查）是否還在、輸入內容是否還在（對應 1.2／3.2 的存活模式）。
3. **`.icon-lock-btn` 熱區**：iPhone SE（375px 最窄機型）上跟品牌文字／`profileChips()` 是否重疊（對應 3.3）。
4. **非 standalone 模式的邊緣滑動返回**：一般 Safari 分頁（不是加入主畫面）裡 `#/parent` ↔ `#/parent/investments` 的邊緣滑動返回手勢視覺表現——這是 SPA hash 路由（`#app` 節點整個替換）在 Safari 滑動預覽動畫下的已知限制類型，本規格不因此改動路由架構（改用 View Transitions API 或保留舊節點做動畫是明顯的範圍擴張，超出「最小改動」原則），但**必須**在真機測過，若視覺瑕疵明顯到影響使用，回頭跟作者討論是否值得為此加動畫過渡（不在本規格範圍內預先解決）。
5. **`--dock`／`--kb` 疊加後的 `.status-toast` 位置**：四個頁面、鍵盤彈出時，toast 是否正確浮在貼底列上方、沒有重疊或跳動。

### 3.8 其他新增 CSS class 一覽

| class | 用途 | 頁面 |
|---|---|---|
| `.record-bar` | 首頁貼底記帳按鈕列（≤650px 顯示，>650px `display:none`） | 首頁 |
| `.wallet-scroll-hint` | 「← 左右滑動看三個帳戶 →」提示行（≤650px 顯示） | 首頁 |
| `.icon-lock-btn` | 情境式解鎖圖示 | dreams／history |
| `.history-month-header` | sticky 月份標頭 | history |
| `.modal.sheet` | 擴充既有 modal 的滑入變體（本次規格未強制使用） | 共用（備用） |
| `.wallet-grid`（手機斷點新規則） | 橫向捲動＋邊緣遮罩，**不是**照抄 `.parent-profile-row` 的 78vw 單卡佔滿 | 首頁 |
| `.rule-list`（手機斷點新規則） | 2×2 grid 壓縮「我們家的約定」高度 | 首頁 |
| `.reflection-month-picker button`（既有 class 改尺寸） | 箭頭 36px→44px | dreams |

不新增任何 design token，全部沿用 `:root` 既有的 `--ink`/`--cream`/`--paper`/`--green`/`--yellow`/`--pink`/`--mint`/`--theme-*`。

---

## 4. 文案表（哪些精簡、去向、語意是否保留）

| 位置 | 現行文案 | 新版位置 | 點擊次數 | 語意保留 |
|---|---|---|---|---|
| 首頁 hero eyebrow／h1 | 原位置 | `.hero-copy` 不變 | 0 | 是（原文） |
| 比例列「35%先留給未來／65%自己做選擇」 | `.hero-practice` | 不變，不新增第二處重複陳列 | 0 | 是（原文） |
| ETF小森林「長期投資，會漲也會跌」 | `moneyCard()` caption | 不變，`moneyCard()` 內容完全不動，只改外層橫向捲動排列（見 2.1 節「不照抄 78vw」的取捨） | 0 | 是（原文，保留既有 0持股/有持股切換邏輯） |
| 撲滿／爸媽銀行 caption | `moneyCard()` caption | 不變 | 0 | 是（原文） |
| 花園「已經存給未來 X → 現在成長為 Y」 | `islandGarden()` | 不變，位置緊接 wallet-grid 之後 | 0 | 是（原文） |
| 「錢是用來練習選擇，不是拿來考試。」＋副標＋四條規則 | `.rules-section` | 不變，不收合，2×2 grid 壓縮高度 | 0 | 是（逐字保留） |
| 家庭小專案說明句（兩句） | `.projects-section` | **（本輪修訂）移到 `<details>` 外面、summary 下方常駐顯示**，不隨收合狀態隱藏 | 0（原本規劃收合狀態 1，本輪改為常駐可見） | 是（原文，未刪減，且比上一版更容易看到） |
| 夢想罐「撲滿金額改變時，這裡會自動更新．不會另外扣款」 | 夢想罐卡片旁 | 確認緊貼短期進度卡，不隨任何收合機制隱藏 | 0 | 是（原文） |
| dreams hero「先問：這筆錢什麼時候要用？」 | `.dream-hero` 主句 | 精簡成單行常駐 | 0 | 是（原文） |
| dreams hero 第二句 | `.dream-hero` 副標 | 收進 `infoTip()`（❔） | 1 | 是（原文，不刪） |
| ETF「非即時報價」等操作性 InfoTip | 家長頁各處 | 維持既有 InfoTip 機制，位置隨對應表單搬到 `#/parent/investments` | 1（既有機制） | 是（操作性文字） |
| history hero「所有紀錄都在這裡／每一步都有故事」 | `.history-hero` | 壓成一行「◯◯的錢，每一步都有故事。」 | 0 | 是（保留第二句精神） |
| parent hero「所有家長功能集中在這裡…」 | 常駐段落 | 未解鎖時保留精簡一行；解鎖後整段移除，由待辦區空狀態文案取代 | 0（未解鎖）／不顯示（解鎖後） | 是（操作說明性質，移入指南頁） |
| 家長指南五個核心觀念／三個帳戶說明 | `parent-settings-row` 第一項 | 移到 `#/parent` Hub 最下面 `<details>`，僅 `pinStatus==="setup"` 自動展開 | 收合狀態 1（首次使用時 0） | 是（內容不刪，只搬遷） |
| 「只有一檔持股時的選擇賣出標的」下拉 | 過年收成表單 | 改純文字確認「今年要收成的是：{標的}」 | 0 | 操作性簡化，非理念文字 |
| **（本輪新增）**「查看夢想進度 →」連結 | 折線圖收合摘要 | 依 `activeDreams.length` 動態換文案：有夢想時「查看夢想進度 →」，零夢想時「還沒有夢想，去放進一個 →」 | 1 | 是（保留原空狀態的鼓勵語氣，不是統一用一句蓋掉） |

---

## 5. 頁面暫存規則（重繪後要還原的 UI 狀態）

`app.js` 每次重繪會整個換掉 `#app` 節點（第 112 行），所以任何 `<details open>`、任何篩選/分頁/編輯中狀態，都必須存在各頁面模組自己的 module-scope 變數裡——這是現有四個頁面模組本來就在用的模式（`home.js` 第 17–39 行、`dreams.js` 第 9–24 行、`history.js` 第 14–23 行、`parent.js` 第 18–47 行的 `ui` 物件），本規格延續、擴充。

| 檔案 | 現有變數（不動） | 本次新增變數 | 說明 |
|---|---|---|---|
| `home.js` | `gardenPickerOpen` 等既有 | `projectsPanelOpen`（家庭小專案 details）、`chartPanelOpen`（折線圖摘要 details） | 初始值 `null`；`render()` 若為 `null`，依「**（本輪修訂）**是否有 `open`/`claimed`/`waiting` 狀態的專案」算出預設值並寫回；`mount()` 監聽 `toggle` 事件，使用者手動切換後改寫成明確的 `true`/`false`，之後不再被資料變動覆蓋 |
| `dreams.js` | `selectedMonth`、`editingId` 等既有 | `activeDreamTab`（`"jar" \| "review"`）、`completedJarsOpen`、**`lockModalOpen`／`lockPin`／`lockError`／`lockModalKind`（見 1.2 節）** | 沿用既有「重繪後由 render 讀回」模式，新變數放在同一區塊 |
| `history.js` | `query`、`kind`、`pagesLoaded` 等既有 | **`lockModalOpen`／`lockPin`／`lockError`／`lockModalKind`（見 1.2 節）** | `.icon-lock-btn` 觸發 `openModal` 現在需要存活機制，不能只靠一次性呼叫 |
| `parent.js` | `ui.openDetails`（Set）、`ui.drafts` 等既有 | `ui.openDetails` 涵蓋「孩子資料編輯」`<details>`；**新增 `ui.correctionOpen`／`ui.correctionDraft`／`ui.correctionModalKind`（校正撲滿 modal 的存活狀態，見 2.4 節第 3 項）**；投資相關的既有欄位（`editingPurchaseId`、`editingHarvestId`、`harvestHoldingId`、`destinationDreamId`、`quoteMeta`、`purchaseOperationId` 等，`parent.js` 第 27–36 行）**搬移**到新檔案 `parent-investments.js` | 搬移後 `parent.js` 只保留跟 Hub 本身有關的欄位 |
| `parent-investments.js`（新檔） | 無（新檔案） | 從 `parent.js` 搬來的投資相關 `ui` 子集合；另外新增 `harvestManuallyToggled` | 新檔案自己的模組作用域，`import()` 動態載入後只要沒有整頁重新整理，跨路由往返 `#/parent` ↔ `#/parent/investments` 可保留 |

**深連結 query（`?open=purchase`/`?open=harvest`）**：一次性讀取，不存進模組變數。

**不特別處理、可接受重置的狀態**：捲動位置（本來就會在整頁重繪時重置，不是本次新增的退步）。

---

## 6. 相對現況拿掉／搬走／收起來清單

| 項目 | 處置 | 理由 |
|---|---|---|
| 頂部 `.primary-nav` 四連結文字導覽 | 搬到底部固定 tab bar | 拇指區可達性；順帶讓四個頁面的頂欄自動變矮 |
| 首頁 `.hero-actions` 兩顆記帳按鈕 | **（本輪修訂）不是搬走，是「複製一份到貼底 `.record-bar`，兩份 markup 依斷點各自顯示其中一份」**——桌機/iPad 繼續用 `.hero-actions` 原本的位置與樣式 | 解決「按鈕在螢幕中段偏上、滑走要滑回來」的拇指區問題，同時不犧牲桌機/iPad 的既有樣式（回應理念裁判擋下） |
| 折線圖卡內的夢想罐進度小清單 | 拿掉，改一行動態連結（有夢想/零夢想兩種文案，見 4 節） | 跟 `#/dreams` 是同一份資料的第二次呈現 |
| 首頁「家庭小專案」卡片列表 | 包進 `<details>`，**兩句理念文案移出、常駐在 summary 下方**，判斷開合的條件涵蓋 `waiting` 狀態 | 偶爾才開放的低頻功能不需要常駐佔第一屏，但理念界線文案與孩子自己那筆的等待狀態要看得到 |
| 家長頁「投資」整段 | 搬到新路由 `#/parent/investments` | 全站唯一大到值得獨立成頁的區塊 |
| 家長頁待辦區 | 搬到解鎖後第一個位置 | 唯一「有人在等」的動機，不該被其他內容擋住 |
| 家長頁指南 `guideMarkup()` | 搬到 Hub 最下面，僅 `pinStatus==="setup"` 自動展開 | 第一次用才會點開 |
| dreams／history 頁的家長解鎖卡 | 收成 32×32 小鎖圖示 + `openModal`（**本輪修訂：新增存活機制，見 1.2**） | 未解鎖時完全不佔版面 |
| history 每列編輯／刪除鈕 | 改成僅 `unlocked` 時才渲染 | 未解鎖時不再讓孩子看到永遠按不動的按鈕 |
| history `.history-controls` 650px 斷點的 `display:block` 覆寫 | 刪除，讓 900px 斷點的雙欄 grid 延續 | 搜尋框＋類型下拉並排一行 |
| history `PAGE_SIZE`（40） | 改成 16 | 「載入更多」更快出現 |
| dreams 新增夢想表單 | `<details>` 預設不開 | 低頻動作 |
| dreams 已完成夢想罐清單 | 包進 `<details>` 收合 | 最低頻、紀念性質 |
| dreams「每月回顧」永遠排在頁面最前面 | 改成獨立分頁，非進頁預設看到 | 回顧不該擋住「隨時看」的夢想罐進度 |
| `.site-shell` 的 `overflow:hidden` | **（本輪新增）改成 `overflow-x:hidden`** | 消除 WebKit「fixed 元素被 overflow:hidden 祖先裁掉」的觸發條件（見 0.1、3.1） |
| `body{padding-bottom}`／各 shell 寫死的 `padding-bottom:80px` | **（本輪新增）統一改用 `--dock` CSS 變數** | 消除疊加造成的多餘留白（見 0.1、3.1） |

---

## 7. 必留功能與十條原則逐項核對表

（本節未受本輪批評指出的缺陷影響，內容與上一版相同，完整保留。）

### 7.1 必留功能逐項對照（23 項，全數保留，無一遺漏）

| # | 功能 | 新位置 |
|---|---|---|
| 1 | 孩子切換 | 各頁頂部 `profileChips()`，不變 |
| 2 | 記零用錢（拆分預覽） | 首頁 `.hero-actions`（桌機/iPad）／貼底 `.record-bar`（手機）→ 既有 `openTransactionModal` |
| 3 | 記花費 | 同上 |
| 4 | 三個錢包餘額 | 首頁 `.wallet-grid`（橫向捲動＋邊緣提示），caption 全保留 |
| 5 | 自主多存申請與家長核准 | 撲滿卡「我想多存一點」不變；家長端 Hub 待辦區一鍵核准 |
| 6 | 小島花園 | 首頁，縮小、樹種選擇預設收合 |
| 7 | 總資產折線圖 | 首頁 `<details>` 收合摘要（含明確定義的較上月百分比），展開看完整圖 |
| 8 | 最近紀錄 | 首頁 3 筆（reward 優先保留）＋「查看全部紀錄 →」 |
| 9 | 家庭小專案（認領/送出） | 首頁 `<details>` 收合狀態卡（理念文案常駐），展開看完整 `.project-grid` |
| 10 | 我們家的約定 | 首頁，不收合，2×2 排版全展開 |
| 11 | 夢想罐 | `#/dreams`「夢想罐」分頁 |
| 12 | 每月回顧 | `#/dreams`「每月回顧」分頁 |
| 13 | 所有紀錄 | `#/history`（底部 tab bar 去留見拍板題 1；`#/parent` Hub 一律保留連結，見 2.4） |
| 14 | 家長操作碼設定/解鎖/變更 | `#/parent`（設定/解鎖）＋變更操作碼維持在 `#/parent` |
| 15 | 預先儲蓄比例 | `#/parent` Hub `.savings-inline-panel` |
| 16 | 孩子資料 | `#/parent` Hub `.profile-editor-panel` details |
| 17 | 真實買入 | `#/parent/investments` |
| 18 | 持股 | `#/parent/investments` |
| 19 | 買入紀錄編輯撤銷 | `#/parent/investments` |
| 20 | 過年收成 | `#/parent/investments`（1、2月自動展開，見拍板題） |
| 21 | 資料與備份 | `#/parent` Hub `.parent-device-panel`（四個 details 收合） |
| 22 | 理念與操作指南 | `#/parent` Hub 最下面 details（setup 狀態自動展開） |
| 23 | 加到主畫面提示 | 不受本次改動影響，維持 `app.js` 既有 `install-hint` 機制 |

### 7.2 十條不可違反原則逐條核對

| # | 原則 | 本規格落實方式 |
|---|---|---|
| 1 | 記帳/回顧不做測驗式評分 | 沒有新增任何評分/打勾機制；空狀態一律正向文案 |
| 2 | 先存再花順序 | 記帳表單欄位順序完全不動 |
| 3 | 三個帳戶不合併 | `.wallet-grid` 仍是三張獨立卡；**本輪修訂**卡片改窄露出下一張、加邊緣遮罩與提示行，降低「只看得到一張」的風險；花園合計數字靠位置建立關聯，不新增第四種總額 |
| 4 | 投資會波動、非即時報價 | ETF caption 與提示原文保留，邏輯不動 |
| 5 | 孩子頁無家長操作 | dreams/history 編輯刪除鈕僅解鎖後渲染；`.icon-lock-btn` 曝光位置列為拍板題（見第 8 節） |
| 6 | 夢想罐只是進度尺 | 邏輯完全不動，「不會另外扣款」提示位置明確核對保留 |
| 7 | 小專案先約定後標價 | **本輪修訂**兩句理念文案移到 `<details>` 外常駐顯示，不用展開就看得到 |
| 8 | 爸媽存錢獎勵/過年收成規則 | 邏輯不動；過年收成表單只是搬容器＋加月份自動展開 |
| 9 | 備份只在裝置上 | `.parent-device-panel` 完整保留四項 |
| 10 | 家庭節奏是引導非強制 | 沒有任何步驟做成「未完成就鎖住其他功能」 |

---

## 8. 需要作者拍板的題目

**1. 底部固定分頁列要保留 4 個連結，還是精簡成 3 個（拿掉「所有紀錄」）？**

現在四個連結都會被搬到底部拇指區。但「所有紀錄」是查帳用的工具性入口，不是每天要做的事。**（本輪修訂補充）**：不論選哪個選項，`#/parent` Hub 現在都會有一個「🔍 所有紀錄」連結（見 2.4 節），所以這題的取捨已經不影響「家長完全找不到查帳入口」這個風險，純粹是「底部列要不要更寬鬆」的體感選擇。

- **選項A：維持 4 個連結**（本規格預設方案）。後果：改動最小，底部列每格約 93px 寬。
- **選項B：精簡成 3 個**（首頁／夢想／家長）。後果：拇指列每格變寬到 125px、更好按，孩子想查帳要多一次點擊（但家長在 `#/parent` Hub 隨時有連結）。
- **我的建議**：選項 B。四份理解報告與提案都同意「所有紀錄」是情境入口性質。

**2a. 底部 tab bar 的「家長區」文字連結要不要留在拇指區？**

**（本輪修訂：從舊拍板題 2 拆出，理由見 0.1「建議」採納項）** 這顆連結只是導去 `#/parent`（仍需再次輸入 PIN 才看得到任何家長功能），性質等同現行導覽本來就有的入口，只是曝光度變高、更容易被孩子隨手點到（不會真的動到任何資料）。

- **選項A：保留在底部 tab bar**（本規格預設方案）。後果：跟現行連結性質不變，只是更好按；孩子可能手滑點進去看到 PIN 卡。
- **選項B：移出底部 tab bar**，改成頂欄一個不在拇指區的小連結。後果：底部列只剩孩子真正常用的目的地；家長進家長區要多滑到頂部一次（跟現況比沒有變差）。
- **我的建議**：選項 B。家長專區入口本來就是給家長用，讓它留在不那麼順手的位置更謹慎。

**2b. dreams／history 頁的 `.icon-lock-btn`（情境式解鎖）要不要離開孩子最容易碰到的位置？**

**（本輪修訂：從舊拍板題 2 拆出）** 這顆圖示跟拍板題 2a 的性質不同——它是「一步到位彈出可輸入 PIN 的表單」，不是「導去另一個仍鎖住的頁面」，曝光風險本質更高一點，且不受拍板題 2a 的選擇影響（它本來就不在底部 tab bar 裡）。

- **選項A：維持右上角 32×32（本規格預設方案，見 1.2、3.3 節）**。後果：跟品牌區塊放在一起，不算特別順手也不算特別難按到。
- **選項B：縮小視覺存在感**（例如更小的圖示、更淡的顏色，但保留同樣的擴大熱區以符合可及性標準）。後果：孩子更不容易手滑點到，但需要多一點設計調整。
- **我的建議**：選項A。跟拍板題 2a 的「拇指熱區」性質不同，右上角本來就不是孩子滑動時容易誤觸的位置，不需要額外處理；除非作者觀察到家裡孩子確實常誤觸，再回頭調整。

**3. 是否要加首頁貼底常駐「記一筆」按鈕列（`.record-bar`）？**

**（本輪修訂補充）** 這是本規格在提案3骨幹之外唯一新增的實質範圍。本輪已經解決理念裁判點名的「桌機/iPad 樣式消失」擋下項（見 0.1、3.1）——`.hero-actions` 桌機樣式保留不動，`.record-bar` 只在手機顯示，兩者共用同一組觸發邏輯，不是取捨關係，這題的風險評估因此比上一版更小。

- **選項A：不加**，維持按鈕留在 hero-copy 區塊（手機上也一樣）。後果：零新增固定元素，但沒有解決 brief 點名的拇指區問題。
- **選項B：加一條貼底記帳按鈕列**（本規格已採用）。後果：多一個 `position:fixed` 元素、多一點真機測試面（見 3.7 節驗收清單），換來孩子在畫面任何位置都能一秒記帳。
- **我的建議**：選項 B（已在本規格採用）。三位裁判交叉比對後最一致的訴求，本輪修訂後風險更可控，值得為核心可用性多做這一步。

**4. 夢想罐／回顧的分頁切換，用原生 `<details name="dreamtab">` 還是額外寫 JS？**

原生寫法零 JS，但只有 iOS 17.4+／Safari 17.4+ 才會真的互斥；舊版會退化成兩個分頁都能同時展開（不是壞掉，只是效果打折）。

- **選項A：原生 `<details name>`**（本規格預設方案）。後果：零狀態管理程式碼，但舊裝置上分頁效果會打折。
- **選項B：加 8 行 JS 強制互斥**。後果：多一點程式碼與測試面，但所有裝置行為一致。
- **我的建議**：如果全家裝置都是近兩年內的 iPhone，選項A沒問題；不確定的話直接選項B一次到位，成本很低。

**5. 過年收成表單依月份（1、2月）自動展開，這個月份範圍要不要調整？**

農曆新年落點每年不完全對齊陽曆 1–2 月。

- **選項A：維持陽曆 1、2 月**（本規格已採用）。後果：多數年份涵蓋得到，邏輯最簡單。
- **選項B：擴大到 1/15–2/28** 或其他範圍。後果：涵蓋更完整，但需要作者確認實際使用習慣。
- **我的建議**：選項A先用，這只是「預設展開與否」的體感優化，家長隨時可以手動展開，不影響功能完整性。

**6.（本輪新增，非強制拍板，僅供知情）非 standalone 模式的邊緣滑動返回手勢視覺表現，需要真機驗證，不是本規格能單靠讀原始碼保證的事。**

見 3.7 節第 4 項。

---

## 9. 主線拍板（2026-09-07，建造者以本節為準，與前文衝突時本節優先）

| 題 | 決定 | 落實方式 |
|---|---|---|
| 1＋2a | 底部分頁列只放孩子會用的三個：**首頁／夢想／紀錄**；「家長區」不放底部列 | `primaryNav(active)` 的清單改成三項（home、dreams、history）。家長入口改成每一頁頂欄右上角一顆小圓鈕 `.icon-lock-btn`：在 `#/`（首頁）它是連到 `#/parent` 的 `<a>`（aria-label「家長區」）；在 `#/dreams`、`#/history` 它照 1.2 節開情境式解鎖 modal，modal 底部多一行「前往家長區 →」連結。`#/parent` 與 `#/parent/investments` 的底部列照樣顯示三項、沒有 active。`#/parent` 頂欄保留「🔍 所有紀錄」連結。 |
| 2b | A：右上角 32×32，不特別淡化 | 照 3.3 節 |
| 3 | B：加貼底 `.record-bar` | 照 3.1 節 |
| 4 | B：夢想／回顧分頁用 JS 互斥（不靠 `<details name>`） | 兩個分頁做成 `.dream-tabs` 兩顆 `aria-pressed` 按鈕＋兩個 `section`，`activeDreamTab` 存模組變數；不用 `<details>` |
| 5 | A：陽曆 1、2 月自動展開 | 照 2.4.1 節 |
| 錢包卡（推翻 2.1 第 3 項與 3.1 的橫向捲動） | **三格並排的小磚，不橫向捲動** | 手機斷點 `.wallet-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:8px }`；每張 `.money-card` 直排：icon（20px）、`small` 標題（11px、允許兩行）、`strong` 金額（17px、`font-variant-numeric: tabular-nums`）、`p` caption（10px、最多三行、`overflow:hidden`）。撲滿卡的「🌱 我想多存一點」按鈕移到三格下方成一整行的 `.money-card-action`（仍是同一個 `data-action`）。桌機斷點維持原本三欄大卡。理由：三個帳戶要一眼可比較，橫向捲動一次只看得到一張半。 |
| 頂欄 | 迷你頂欄統一為一列：品牌小字（左）、`profileChips()`（中，可橫向捲動）、右上角圓鈕（右）；高度目標 56–64px | 四頁共用同一個 `common.miniTopbar({ active, ctx, right })` 產生，不再各頁手刻 |
| 文案 | 除本規格第 4 節列出的搬動與精簡外，所有既有文案一字不改 | 建造者若需要新文案（空狀態、summary 一行摘要），語氣照原專案，不超過一句 |

補充硬性規則：
- 只改 `docs/styles.css`（共用層建造者）、`docs/css/<page>.css`（各頁建造者各自一個檔，index.html 已預先連結）、`docs/js/app.js`、`docs/js/ui/*.js`、`docs/sw.js`（CORE 清單與 VERSION）。不動 store／state／backup／gist／db／pin。
- 共用層先做完，四頁再平行做；各頁建造者不准改 `docs/styles.css` 與 `common.js`。
- `docs/dev/selftest.html` 必須仍然 PASS 119。這不是一個需要作者現在選邊站的價值取捨題，而是一項工程風險揭露：`#/parent` ↔ `#/parent/investments` 這種 SPA hash 路由在 Safari 邊緣滑動返回時，理論上可能出現短暫的視覺瑕疵（不影響功能，只影響觀感）。本規格不打算為此提前導入更複雜的頁面過渡機制（那會是明顯的範圍擴張），但請作者知道：如果真機測試後觀感不佳，這會是下一輪才處理的項目，不是這次上線前的必要條件。
