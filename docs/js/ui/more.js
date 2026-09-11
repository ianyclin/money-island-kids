// 小小理財島 PWA：更多頁（規格 5.4）。
// 這是共用層（建造者 A）放的暫時樁，只證明殼與路由接得上；
// 建造者 B 會整個覆蓋這一支。

import { html } from "../util.js";
import { appShell } from "./common.js";

export function render(ctx) {
  return appShell({
    page: "more",
    title: "更多",
    ctx,
    body: html`<p class="empty">這一頁正在重做</p>`,
  });
}

export function mount() {}
