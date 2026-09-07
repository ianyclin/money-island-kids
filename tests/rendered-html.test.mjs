import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("ships product metadata without private family names or starter copy", async () => {
  const [layout, home, dreams, history, parent] = await Promise.all([
    source("app/layout.tsx"),
    source("app/page.tsx"),
    source("app/dreams/page.tsx"),
    source("app/history/page.tsx"),
    source("app/parent/page.tsx"),
  ]);
  const publicClientSource = [layout, home, dreams, history, parent].join("\n");

  assert.match(layout, /小小理財島/);
  assert.doesNotMatch(publicClientSource, /Your site is taking shape|Building your site|codex-preview/);
  // 原本這裡硬寫三個孩子的名字做外洩檢查；倉庫公開前移除，避免測試本身成為外洩來源。
});

test("uses client-side links for the four primary pages", async () => {
  const navigation = await source("app/primary-nav.tsx");
  assert.match(navigation, /from "next\/link"/);
  assert.match(navigation, /<Link/);
  assert.doesNotMatch(navigation, /<a\b/);
  for (const href of ['"/"', '"/dreams"', '"/history"', '"/parent"']) {
    assert.match(navigation, new RegExp(`href: ${href.replaceAll("/", "\\/")}`));
  }
});

test("keeps family responses private and device tokens out of JSON", async () => {
  const [security, deviceAccess, profilePhoto] = await Promise.all([
    source("app/api/request-security.ts"),
    source("app/api/device-access/route.ts"),
    source("app/api/profile-photo/route.ts"),
  ]);

  assert.match(security, /private, no-store/);
  assert.match(security, /Vary|vary/);
  assert.match(security, /Cookie/);
  assert.match(deviceAccess, /token: _token|token, \.\.\.safeResult|safeResult/);
  assert.doesNotMatch(deviceAccess, /trusted: true, \.\.\.result/);
  assert.doesNotMatch(profilePhoto, /public\s*,|immutable/);
});

test("protects every API mutation with same-origin and private-cache checks", async () => {
  const apiRoot = new URL("../app/api/", import.meta.url);
  const entries = await readdir(apiRoot, { recursive: true });
  const mutationRoutes = [];

  for (const entry of entries) {
    if (typeof entry !== "string" || !entry.endsWith("route.ts")) continue;
    const route = await readFile(new URL(entry, apiRoot), "utf8");
    if (!/export async function (?:POST|PATCH|PUT|DELETE)\b/.test(route)) continue;
    mutationRoutes.push(entry);
    assert.match(route, /rejectUntrustedMutationOrigin/, `${entry} must reject cross-origin mutations`);
    assert.match(route, /privateJson|privateResponseHeaders/, `${entry} must disable shared caching`);
  }

  assert.ok(mutationRoutes.length >= 15, "the mutation-route audit should cover the complete API surface");
});

test("refreshes supported holdings from the official latest-close endpoint in the background", async () => {
  const [cache, route, store, quoteLibrary] = await Promise.all([
    source("app/money-state-cache.tsx"),
    source("app/api/market-quotes/route.ts"),
    source("db/money-store.ts"),
    source("lib/market-quotes.ts"),
  ]);

  assert.match(cache, /JSON\.stringify\(\{ mode: "auto" \}\)/);
  assert.match(cache, /void refreshAutomaticMarketQuotes/);
  assert.match(cache, /window\.localStorage\.setItem\(storageKey/);
  assert.match(cache, /AUTO_QUOTE_RETRY_AFTER_MS = 30 \* 60_000/);
  assert.match(route, /mode: body\.mode === "auto" \? "auto" : "parent"/);
  assert.match(store, /if \(input\.mode !== "auto"\) await assertParentPin/);
  assert.match(store, /No balances, units, or symbols are accepted from the client/);
  assert.match(quoteLibrary, /https:\/\/openapi\.twse\.com\.tw\/v1\/exchangeReport\/STOCK_DAY_AVG_ALL/);
});

test("backs up canonical family state and validates uploads before replacement", async () => {
  const [store, route, panel, parent] = await Promise.all([
    source("db/money-store.ts"),
    source("app/api/backups/route.ts"),
    source("app/parent/device-trust-panel.tsx"),
    source("app/parent/page.tsx"),
  ]);
  const backupInsertions = store.match(/INSERT INTO backups\s*\(/g) ?? [];

  assert.equal(backupInsertions.length, 1, "all mutations must route through the canonical backup writer");
  assert.match(store, /readCompleteBackupState/);
  assert.match(store, /validateBackupEnvelope\(value\)/);
  assert.match(store, /r2_status/);
  assert.match(store, /上傳還原前自動備份/);
  assert.match(store, /await d1\.batch\(statements\)/);
  assert.match(store, /Holdings are the canonical source for investment aggregates/);
  assert.match(store, /getRequestExecutionContext/);
  assert.match(store, /executionContext\.waitUntil\(backgroundCopy\)/);
  assert.match(store, /money-island-portable-backup/);
  assert.match(store, /remapPortableState/);
  assert.match(store, /profile-photos\/\$\{familyId\}\/\$\{profileId\}/);
  assert.match(store, /MAX_PORTABLE_PHOTO_TOTAL_BYTES/);
  assert.match(route, /export-portable/);
  assert.match(route, /summary\.portable/);
  assert.match(panel, /下載完整可攜備份/);
  assert.match(panel, /不含密碼、家長操作碼或裝置信任/);
  assert.match(panel, /請先在頁面上方輸入家長操作碼解鎖/);
  assert.match(panel, /正在整理照片/);
  assert.match(parent, /document\.body\.appendChild\(link\)/);
  assert.match(parent, /setTimeout\(\(\) => URL\.revokeObjectURL\(objectUrl\), 30_000\)/);
});

test("keeps parent controls compact and makes monthly reviews browsable", async () => {
  const [parent, dreams, stateRoute, store] = await Promise.all([
    source("app/parent/page.tsx"),
    source("app/dreams/page.tsx"),
    source("app/api/state/route.ts"),
    source("db/money-store.ts"),
  ]);

  assert.match(parent, /className="savings-stepper"/);
  assert.match(parent, /profile-editor-switcher/);
  assert.doesNotMatch(parent, /照片、名字與撲滿/);
  assert.doesNotMatch(parent, /profile-reward-control/);
  assert.doesNotMatch(parent, /className="parent-summary"/);
  assert.doesNotMatch(parent, /profile-editor-close/);
  assert.match(dreams, /setSelectedMonth/);
  assert.match(dreams, /這個月我存給未來/);
  assert.match(dreams, /monthAssetChange/);
  assert.match(dreams, /monthSpendCount/);
  assert.match(stateRoute, /ensureMonthlySavingsRewards/);
  assert.match(store, /operationId = `reward:\$\{profile\.id\}:\$\{month\}`/);
  assert.match(store, /每月第一次開啟帳本時自動發放/);
});

test("honors reduced-motion preferences for decorative animation", async () => {
  const css = await source("app/globals.css");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /animation:\s*none\s*!important/);
});

test("keeps high-frequency controls above the fold on tablets and compact on phones", async () => {
  const css = await source("app/globals.css");

  assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.parent-profile-row \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}/);
  assert.match(css, /\.history-controls \{ position: static; padding: 18px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; \}/);
  assert.match(css, /@media \(max-width: 650px\)[\s\S]*?scroll-snap-type: x mandatory/);
  assert.match(css, /\.hero \{ min-height: 0; grid-template-columns: 1fr;/);
});
