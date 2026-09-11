# 小小理財島 v2 重做規格

作者 2026-09-11 授權：「重新檢視這個網頁設計，把理念和功能，用自己的想法，重構成一個沒問題的新網頁（必須在電腦和手機都友善使用）。」設計決定權交給主線。本文件是四位建造者的唯一依據。

## 0. 為什麼重做，以及這次不准再犯的錯

上一版（`pwa-mobile`）把「手機優先」做成了「壓縮」：三條固定橫條吃掉 23% 螢幕、字縮到 10–12px、到處是收起來的 `<details>`、電腦版變成拉寬的手機頁。根本原因是在原本為電腦設計的 2,500 行樣式表上不斷補丁。

這次的原則：

1. **搬走，不縮小。** 不是每天要看的內容各自一頁；留在首頁的東西保持大字與呼吸空間。
2. **樣式表從零寫。** 手機為基準，往上放大到平板與電腦。`docs/styles.css` 與 `docs/css/*.css` 整批作廢。
3. **一條導覽，沒有第二條固定橫條。** 手機底部分頁列；平板與電腦左側欄。
4. **抽屜只用在真的低頻的地方**（已完成的夢想、指南、備份的三個子面板）。首頁零抽屜。
5. **字級下限**：內文 14px、輔助字 12px、絕不低於 12px。
6. **業務規則零改動**：`store.js`、`state.js`、`backup.js`、`gist.js`、`db.js`、`pin.js`、`quotes.js`、`util.js` 一行不動。頁面模組只換畫面，store 呼叫、operationId、錯誤處理原樣搬。

## 1. 不變的東西（孩子認得的樣子）

- 色票：`--ink #173b36`、`--muted #65736f`、`--cream #f7f3e8`、`--paper #fffdf8`、`--green #356f61`、`--green-deep #224e45`、`--line #e7e1d3`、`--yellow #f4c75d`、`--pink #ef9db7`、`--mint #72bba5`。
- 每個孩子的主題色：`--kid-accent` 由 profile.accent 注入到頁面根節點（沿用 `moneyThemeStyle` 的做法），派生 `--theme-page / --theme-paper / --theme-scene / --theme-soft / --theme-rules / --theme-ground / --theme-leaf`，公式照舊 styles.css 第 104–114 行原樣搬。
- 字體：標題 `"Iowan Old Style", "Noto Serif TC", serif`；內文 `"PingFang TC", "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif`。
- **小島插畫整段原樣搬**：舊 styles.css 的 `.island-scene`（470 起）、`.sun`、`.island-ground`、`.island-garden`、`.island-garden > span`（含 `.is-growing`、`.garden-seed`、`species-*`）、`.garden-picker`、`.scene-total`、`.scene-total-avatar`，以及 home.js 的 `islandGarden()` 函式（forestLayout 座標、成長比例、樹種清單）。這是插畫程式，不是排版，不准重寫。
- **折線圖整段原樣搬**：`.asset-chart`、`.chart-y-axis`、`.chart-plot`、`.line-chart-stage`（含 svg/line/polygon/polyline）、`.chart-point`、`.chart-x-axis`，以及 home.js 的 `assetTimeline()` 與 `assetGrowthChart()`。
- `.timeline-dot` 各 kind 的配色（舊 styles.css 965 起）原樣搬。
- 所有使用者看得到的文案一字不改，除非本規格明列。
- 三個錢包的名字與說明：「可以自己決定（撲滿）」「爸媽銀行」「ETF 小森林」與各自 caption 的邏輯。
- 理念句子必須留在孩子看得到的地方：「先存再花」比例列在首頁；「錢是用來練習選擇，不是拿來考試」在「更多」頁的約定卡；「長期投資，會漲也會跌」在 ETF 錢包 caption；「夢想罐只是進度尺，不會另外扣款」在成長頁。

## 2. 資訊架構與路由

| 路由 | 分頁名 | 圖示 | 內容 | 頻率 |
|---|---|---|---|---|
| `#/` | 首頁 | 🏠 | 孩子切換、三個錢包、記帳兩顆大按鈕、小森林、最近三筆 | 每天 |
| `#/growth` | 成長 | 🌱 | 總資產折線圖、夢想罐、每月回顧 | 每週／每月 |
| `#/history` | 紀錄 | 📒 | 所有紀錄：搜尋、類型、月份分組 | 查帳時 |
| `#/more` | 更多 | ✨ | 家庭小專案、我們家的約定、家長區入口、關於 | 偶爾 |
| `#/parent` | （無分頁） | | 家長區，需操作碼 | 家長 |
| `#/parent/investments` | （無分頁） | | 投資管理子頁 | 家長 |
| `#/setup` | （無分頁） | | 第一次使用 | 一次 |

`#/dreams` 保留為 `#/growth` 的別名（舊連結不斷）。`app.js` 的 ROUTES 依此改；`currentHash()` 邏輯不變。

家長入口：「更多」頁最下方一張卡「👨‍👩‍👧 家長區」→ `#/parent`。成長頁與紀錄頁的標題列右側各有一顆 32px 鎖鈕（沿用 `common.createLockModal`），只在有家長編輯功能的頁面出現。

## 3. 殼（shell）

`common.js` 提供 `appShell({ page, title, ctx, right, body })`，四個分頁頁面與家長頁都用它包起來；setup 不用。

### 3.1 手機（< 768px）

```
┌──────────────────────────┐
│ 頁面標題          [右插槽] │  .page-head：48px，標題 serif 20px；右插槽放鎖鈕或空
│                          │
│  內容（單欄，左右各 16px） │  .page-body
│                          │
├──────────────────────────┤
│ 🏠首頁 🌱成長 📒紀錄 ✨更多 │  .tabbar：fixed bottom，56px + safe-area；圖示 20px、字 11px
└──────────────────────────┘
```

- `.page-body` 的 `padding-bottom: calc(56px + env(safe-area-inset-bottom) + 24px)`，唯一的貼底補償，寫在 shell 上，各頁不再自己補。
- 首頁的 `.page-head` 不放標題，放孩子切換列（見 5.1）。
- 家長頁在 `.page-head` 右插槽放「🔓 已解鎖」小字；家長頁與投資子頁的 `.tabbar` 照樣顯示四個分頁、無 active。
- 沒有任何其他 `position: fixed` 元素。toast 用 `position: fixed; bottom: calc(56px + safe-area + 12px)`。

### 3.2 平板與電腦（≥ 768px）

```
┌────────┬────────────────────────────────────┐
│ ¢      │ 頁面標題                    [右插槽] │
│ 小小   │                                    │
│ 理財島 │  內容（max-width 1040px，置中）      │
│        │                                    │
│ 🏠首頁 │                                    │
│ 🌱成長 │                                    │
│ 📒紀錄 │                                    │
│ ✨更多 │                                    │
│        │                                    │
│ ──── │                                    │
│ 🐯大寶 │  （孩子切換在側欄底部，直排）        │
│ 🐰二寶 │                                    │
└────────┴────────────────────────────────────┘
```

- `.sidebar`：`position: sticky; top: 0; height: 100dvh`，寬 220px（≥ 1100px 時 240px），背景 `--paper`，右邊 1px `--line`。
- `.tabbar` 在 ≥ 768px `display: none`；`.sidebar` 在 < 768px `display: none`。同一份 markup，CSS 切換。
- `.page-body` 左右 padding 32px（≥ 1100px 時 48px），`padding-bottom` 48px。
- ≥ 1100px 時各頁依規格切兩欄（見第 5 節「電腦」段）。

### 3.3 側欄與分頁列的 markup（common.js 產生）

```html
<div class="app">
  <aside class="sidebar">
    <a class="brand" href="#/"><span class="brand-mark">¢</span><b>小小理財島</b><small>先存一點，夢想長大</small></a>
    <nav class="sidenav">…四個 <a class="navitem [is-active]" href="#/…"><i>🏠</i><span>首頁</span></a>…</nav>
    <div class="sidebar-kids">…profileChips 直排版（data-choose-profile）…</div>
  </aside>
  <main class="page" data-page="home">
    <header class="page-head">…</header>
    <div class="page-body">…</div>
  </main>
  <nav class="tabbar">…四個 <a class="tab [is-active]" href="#/…"><i>🏠</i><span>首頁</span></a>…</nav>
</div>
```

`app.js` 的 render() 換掉的仍是 `#app` 內容；`appShell()` 回傳整個 `.app`。頁面模組的 `render(ctx)` 回傳 `appShell({...})` 的結果；`mount(root, ctx)` 在 root 上綁事件（root 是 `#app`，委派照舊）。`data-choose-profile` 的委派由 `app.js` 或 common 統一接（現況已有，沿用）。

## 4. 設計系統（app.css 的骨架）

### 4.1 tokens

```css
:root {
  /* 色票、主題色派生：第 1 節 */
  --font-serif: "Iowan Old Style", "Noto Serif TC", serif;
  --font-sans: "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif;
  --fs-display: 30px;   /* 首頁問候、頁面大標；≥768 34px；≥1100 40px */
  --fs-title: 20px;     /* 頁面標題、卡片標題 */
  --fs-body: 15px;
  --fs-small: 13px;
  --fs-caption: 12px;   /* 下限 */
  --fs-amount: 26px;    /* 錢包金額；≥768 30px */
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 24px; --space-6: 32px; --space-7: 48px;
  --radius-s: 12px; --radius-m: 18px; --radius-l: 26px;
  --shadow-card: 0 1px 0 rgba(255,255,255,.7) inset, 0 6px 20px rgba(23,59,54,.06);
  --tap: 48px;          /* 所有可點元素的最小高度 */
}
```

### 4.2 元件（class 名稱固定，建造者照用）

| class | 用途 | 規格 |
|---|---|---|
| `.card` | 所有卡片 | 背景 `--theme-paper`，邊 1px `--line`，圓角 `--radius-l`，padding `--space-5`（手機 `--space-4`） |
| `.card-title` | 卡片標題 | serif `--fs-title`，下方 `--space-3` |
| `.kicker` | 小標眉 | sans 12px、字距 .08em、`--muted`、大寫感 |
| `.btn` `.btn-primary` `.btn-secondary` `.btn-ghost` `.btn-danger` | 按鈕 | 高 `--tap`，圓角 999px，字 15px 900；primary 底 `--green` 字白；secondary 白底 1px `--line`；ghost 透明；danger 底 #8f3650 |
| `.btn-block` | 滿版按鈕 | width 100% |
| `.btn-row` | 按鈕橫排 | flex gap 8px；手機每顆 flex:1 |
| `.field` `.field-label` `.input` `.select` `.textarea` | 表單 | input 高 `--tap`，圓角 `--radius-s`，字 16px（避免 iOS 放大） |
| `.money-input` | 金額輸入 | 左側 NT$ 前綴 |
| `.quick-amounts` | ＋10／＋100／＋1000 | 三顆等寬 pill |
| `.wallet` `.wallet-yellow/.wallet-pink/.wallet-green` | 錢包列 | 見 5.1 |
| `.record-list` `.record` | 紀錄列 | 見 5.3 |
| `.profile-chips` `.chip` | 孩子切換（橫排） | chip 高 44px，頭像 28px＋名字 14px，active 用 `--profile-color` 淡底 |
| `.sidebar-kids .chip` | 孩子切換（直排） | 同上，排成一直行 |
| `.segmented` | 分段切換 | 兩到三段，高 44px，active 底 `--green` 字白 |
| `.modal-backdrop` `.modal` `.modal-close` | modal | **邏輯沿用 common.js 現有的 openModal/closeModal/confirmDialog，只換樣式**；手機從底部滑入（`align-items: flex-end`、上圓角 24px、max-height `calc(100dvh - 40px - var(--kb, 0px))`）；≥768 置中、max-width 520px |
| `.toast` | 提示 | 沿用 showStatus 邏輯 |
| `.lock-btn` | 32px 鎖鈕 | 沿用 lockIconButton |
| `.empty` | 空狀態 | 置中、`--muted`、一句話 |
| `.stat` `.stat-value` `.stat-label` | 數字磚 | 成長頁三個數字用 |
| `.progress` `.progress > i` | 進度條 | 高 10px 圓角 |
| `.badge` | 狀態小標 | pill 12px |
| `.inbox-item` | 家長待辦一列 | 左文右兩顆按鈕 |
| `.grid-2` | ≥1100 兩欄 | `grid-template-columns: 3fr 2fr`（首頁 5:4） |

### 4.3 手機 modal 的存活機制不准丟

`app.js` 每次重繪前呼叫 `closeModal("rerender")`；各頁 onClose 收到 `"rerender"` 只清「DOM 開著」旗標、不清「該開」旗標，mount 再補開並回填。`common.createLockModal`、home 的記帳／多存 modal、history 的編輯 modal、growth 的已完成夢想編輯、parent 的校正撲滿 modal，全部沿用現有寫法。

## 5. 逐頁規格

估高以 375×812 計，內容區高度扣掉 page-head 48 與 tabbar 56 約 700px。

### 5.1 首頁 `#/`

**手機，由上到下：**

| # | 區塊 | 內容 | 估高 |
|---|---|---|---|
| 1 | `.page-head` | `.profile-chips` 橫排（可捲），右插槽空 | 48 |
| 2 | `.greeting` | serif `--fs-display`：「{name}的錢，正在慢慢長大。」下一行 sans 13px `--muted`：「零用錢 {rate}% 先留給未來，{100-rate}% 自己做選擇」 | 96 |
| 3 | `.wallets` 三列 `.wallet` | 每列：左 36px icon（🐷🏦🌳）、中 名稱 13px + caption 12px（兩行內）、右 金額 `--fs-amount` serif tabular。爸媽銀行列若有 pending 多存，caption 下加一行 `.badge`「⌛ $20 等待爸媽確認」。三列之間 8px。整塊是一張 `.card`。 | 240 |
| 4 | `.btn-row` | 「＋ 記一筆零用錢」primary、「記一筆花費」secondary，各 `--tap` 高 | 48 |
| 5 | `.wallet-action` | 一顆 `.btn-ghost .btn-block`「🌱 我想多存一點到爸媽銀行」 | 44 |
| 6 | `.card.island-card` | `islandGarden()` 原樣；`.island-scene` aspect-ratio 1.15；樹種選擇 `.garden-picker` 照舊是 details（這是唯一的例外，因為它是插畫的一部分） | 360 |
| 7 | `.card.recent` | `.card-title`「最近紀錄」＋右側「看全部 →」；三筆 `.record`（規則：最近 3 筆，若本月有 reward 不在其中則換進第 3 格——沿用現有 `recentActivities()`）；沒有紀錄時 `.empty`「還沒有紀錄，記第一筆看看」 | 220 |

合計約 1,050px ≈ 1.5 屏。第一屏（700px）看得到：切換、問候、三個錢包、兩顆按鈕、多存鈕、小島的上半。

**電腦（≥1100）**：`.grid-2`（5:4）。左欄：問候、錢包卡、按鈕列、多存鈕、最近紀錄。右欄：小島卡（sticky top 24px）。問候字級 40px。

**modal**：記帳（零用錢／花費）與自主多存兩個 modal 的欄位、預覽、快速金額、文案、operationId、存活機制全部沿用現有 home.js；只把 markup 換成 `.field/.input/.money-input/.quick-amounts/.btn` 這組 class。

**不在首頁的東西**：折線圖→成長；夢想罐進度→成長；家庭小專案→更多；我們家的約定→更多；footer→更多頁最底。

### 5.2 成長 `#/growth`（取代 dreams）

**手機：**

| # | 區塊 | 內容 | 估高 |
|---|---|---|---|
| 1 | `.page-head` | 標題「成長」，右插槽 `.lock-btn` | 48 |
| 2 | `.segmented` | 「📈 資產」「🎯 夢想罐」「📝 每月回顧」三段；`activeTab` 存模組變數，預設「資產」 | 44 |
| 資產段 | `.card` | `.card-title`「總資產」＋右側大字金額；`assetGrowthChart()` 原樣；下方一行 13px：「從 {year} 年開始 · 累積第 {n} 年」 | 320 |
| 夢想罐段 | `.card` ×N | 進行中的短期／長期各一張：標題、`.badge`（短期·撲滿／長期·爸媽銀行＋ETF）、`{saved} / {target}`、`.progress`、百分比；下方固定一行 12px「撲滿金額改變時，這裡會自動更新；夢想罐只是進度尺，不會另外扣款」。家長解鎖後每張卡底部出現「編輯／完成／刪除」`.btn-ghost` 三顆。 | 每張 150 |
| | `.btn-block .btn-secondary` | 「＋ 新增夢想」→ 開 modal（欄位沿用現有：名稱、短期／長期、目標金額） | 48 |
| | `.card` | 「排隊中的短期夢想」清單（有才顯示），每列名稱＋目標＋「開始」鈕（家長） | 依筆數 |
| | `<details class="card">` | 「已完成的 {N} 個夢想」——唯一允許的抽屜，內容是完成日期、歷時、金額；家長解鎖可「編輯」（沿用 completedEditor modal） | 收合 56 |
| 回顧段 | `.card` | 月份切換（‹ 2026 年 9 月 ›，按鈕 44px）；三個 `.stat`（這個月存給未來／全部的錢變化／做了什麼選擇，數字與說明沿用現有計算）；三題 `.textarea`（文案原樣）；「存下這個月的回顧」primary；已存過顯示「{月} 回顧已存好」 | 560 |

**電腦**：不用 segmented，三段同時顯示：`.grid-2`（3:2）左欄「資產」卡在上、「夢想罐」在下；右欄「每月回顧」。

### 5.3 紀錄 `#/history`

**手機：**

| # | 區塊 | 內容 |
|---|---|---|
| 1 | `.page-head` | 標題「{name}的紀錄」（跟著選中的孩子），右插槽 `.lock-btn` |
| 2 | `.profile-chips` | 橫排（含各自筆數小字） |
| 3 | `.filters` | 一列：`.input` 搜尋（placeholder 照舊）＋ `.select` 類型；`position: sticky; top: 0` 在 `.page-body` 內，背景 `--theme-page` |
| 4 | `.month-head` | sticky 月份標頭「2026 年 9 月」（12px `--muted` 大寫感，底線） |
| 5 | `.record` ×N | 每列：左 `.timeline-dot`（36px，kind 配色原樣）；中 標籤 15px 900 ＋ 下一行 12px `--muted`「9/6 · 零用錢 · 備註」（備註最多兩行）；右 金額 15px serif tabular（正數綠、負數 `--ink`）。家長解鎖時，列可左滑？不做——改成列右側多一顆 `.btn-ghost` 32px「⋯」開 modal 選「編輯／刪除」。 |
| 6 | `.btn-block .btn-secondary` | 「載入更多（已顯示 N / M）」PAGE_SIZE 20 |

`getActivitiesPage`、`groupByMonth`、debounce、編輯 modal、刪除確認、可刪除判斷全部沿用現有 history.js。

**電腦**：單欄 max-width 760px 置中；filters 不 sticky；記錄列右側直接顯示「編輯／刪除」兩顆 ghost（解鎖時）。

### 5.4 更多 `#/more`（新頁）

**手機，由上到下（全部 `.card`，沒有抽屜）：**

| # | 卡 | 內容 |
|---|---|---|
| 1 | 家庭小專案 | `.kicker`「偶爾才開放」`.card-title`「家庭小專案」；常駐兩句：「只有家長事前約定、超出日常責任的完整任務才會出現在這裡。」「完成後才發放，報酬一樣先存 {rate}%」；專案卡列表（狀態、報酬、標題、描述、按鈕：`claim-project`／`submit-project` 邏輯與文案沿用 home.js）；沒有專案時 `.empty`「目前沒有開放的小專案」 |
| 2 | 我們家的約定 | 深色底（`--theme-rules`）白字卡：`.kicker`「我們家的約定」、serif 26px「錢是用來練習選擇，不是拿來考試。」、副標、四條規則（01–04，標題 16px、內文 14px），單欄 |
| 3 | 家長區 | `.card` 一列：「👨‍👩‍👧 家長區」＋ 13px「管理帳本、專案與投資，需要家長操作碼」＋ 右側「進入 →」→ `#/parent` |
| 4 | 關於 | 小字：「小小理財島 · 讓好習慣慢慢長大」＋ 著作注記連結（原 footer 內容）＋ 版本（讀 sw.js 的 VERSION 不可行，寫死一行「v2」由建造者放常數） |

**電腦**：`.grid-2`：左欄專案卡、家長區、關於；右欄約定卡（sticky）。

### 5.5 家長區 `#/parent` 與 `#/parent/investments`

結構與功能照現有 parent.js／parent-investments.js（待辦收件匣 → 快速動作 → 預先儲蓄比例 → 孩子資料 → 投資入口 → 家庭小專案管理 → 資料與備份 → 指南），**只換成新的 class 與 shell**。要求：

- 未解鎖：`.page-head` 標題「家長區」；內容只有一張 `.card` 解鎖表單（操作碼 setup／locked 兩態文案沿用）＋ 一行 12px「解鎖後才能看到家長功能」。不顯示備份面板。
- 已解鎖：`.page-head` 右插槽「🔓 已解鎖 · 變更操作碼」小連結（開 modal）。
- 待辦：`.card` 標題「待辦」，每筆 `.inbox-item`；空狀態文案「這個月都核對過了 ✓」。
- 快速動作：`.btn-row` 三顆 secondary（記買入／記收成／校正撲滿）。
- 其餘各段各一張 `.card`；資料與備份的三個子面板（下載上傳／本機快照／GitHub 雲端）與指南是允許的抽屜。
- 投資子頁：`.page-head` 標題「投資管理」、左側「‹ 家長區」返回；買入表單、持股卡、買入紀錄、過年收成各一張 `.card`；收成的 1、2 月自動展開與深連結 `?open=` 沿用。
- **電腦**：`.grid-2`（3:2）左欄待辦、快速動作、比例、孩子、專案；右欄投資入口、備份、指南。投資子頁單欄 max-width 760。

### 5.6 第一次使用 `#/setup`

不用 shell。置中一張 `.card`（max-width 480）：品牌、一句話、`.segmented`「建立新帳本／從備份還原」、表單（欄位與驗證沿用現有 setup.js）。

## 6. 頁面模組的介面（不變）

- `render(ctx)` 回傳 html；`mount(root, ctx)` 綁事件委派。
- `ctx = { state, view, profile, profiles, unlocked, pinStatus, navigate, refresh, chooseProfile }`。
- 只准 import：`../util.js`、`./common.js`、`../store.js`、`../state.js`、`../pin.js`、`../backup.js`、`../db.js`（只准 listSnapshots／restoreSnapshot）、`../gist.js`（只准 renderGistPanel／mountGistPanel）。
- 所有 `data-action` 名稱沿用現有（清單見 `notes/redesign-v2/data-actions.txt`），對應的 handler 邏輯原樣搬。

## 7. 檔案清單與分工

| 建造者 | 產出 | 依賴 |
|---|---|---|
| A 共用層 | `docs/app.css`（整份新樣式，含第 1 節原樣搬的插畫與折線圖區塊）、`docs/js/ui/common.js`（appShell、tabbar／sidebar、profileChips 兩種、元件 helper；**modal／toast／confirmDialog／createLockModal／lockIconButton 的邏輯原樣保留，只換 class**）、`docs/js/app.js`（新路由表、`#/dreams` 別名）、`docs/index.html`（只載 app.css）、`docs/sw.js`（CORE 清單：移除 styles.css 與 css/*.css，加 app.css、growth.js、more.js；VERSION v6） | 無 |
| B 首頁與更多 | `docs/js/ui/home.js`（重寫）、`docs/js/ui/more.js`（新） | A |
| C 成長與紀錄 | `docs/js/ui/growth.js`（從 dreams.js 改造，dreams.js 刪除）、`docs/js/ui/history.js`（重寫版面） | A |
| D 家長與設定 | `docs/js/ui/parent.js`、`docs/js/ui/parent-investments.js`、`docs/js/ui/setup.js`（換 class 與 shell） | A |

- 頁面建造者**不准改 app.css**。真的需要頁面專屬樣式，寫在各自的 `docs/css/<page>.css`（A 會在 index.html 預留四個 link 與空檔），並在回報裡列出；主線會決定併回 app.css 或砍掉。
- 舊的 `docs/styles.css` 與 `docs/css/*.css` 由主線在整合後刪除。
- `docs/dev/selftest.html` 必須仍然 PASS 119。

## 8. 驗收（主線做）

- 375、768、1100、1280 四個寬度，六個路由，零 console error。
- 手機首頁第一屏看得到三個錢包與兩顆按鈕；整頁 ≤ 1.6 屏。
- 沒有任何字小於 12px（用 JS 掃 `getComputedStyle` 全部文字節點）。**唯一例外**：折線圖座標軸標籤（`.chart-y-axis`、`.chart-x-axis`）維持 10px，這是圖表慣例；小島下方的「已經存給未來」與樹種選擇已由主線提到 12px。
- 只有 `.tabbar`、`.toast`、modal 是 `position: fixed`。
- 真實備份（作者 9/7 匯出）匯入後四頁正常。
- 背景重繪時，記帳 modal 打到一半的金額仍在。
- 引擎自測 PASS 119。
