// 小小理財島 PWA：成長頁（規格 5.2）。
// 這是共用層（建造者 A）放的暫時樁，只證明殼與路由接得上；
// 建造者 C 會用 dreams.js 改造後的內容整個覆蓋這一支。

import { html } from "../util.js";
import { appShell } from "./common.js";

export function render(ctx) {
  return appShell({
    page: "growth",
    title: "成長",
    ctx,
    body: html`<p class="empty">這一頁正在重做</p>`,
  });
}

export function mount() {}
