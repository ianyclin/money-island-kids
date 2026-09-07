import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("serializes family mutations and deduplicates client retries", async () => {
  const [store, transactions, savings, migration] = await Promise.all([
    source("db/money-store.ts"),
    source("app/api/transactions/route.ts"),
    source("app/api/savings-transfers/route.ts"),
    source("drizzle/0012_heavy_angel.sql"),
  ]);

  assert.match(store, /withFamilyMutationLock/);
  assert.match(transactions, /withFamilyMutationLock/);
  assert.match(savings, /withFamilyMutationLock/);
  assert.match(transactions, /operationId/);
  assert.match(savings, /operationId/);
  assert.match(migration, /idx_activities_family_operation/);
  assert.match(migration, /idx_savings_transfers_family_operation/);
});

test("keeps committed money changes usable when a backup copy needs retrying", async () => {
  const store = await source("db/money-store.ts");

  assert.match(store, /backupHealth/);
  assert.match(store, /status: "failed"/);
  assert.match(store, /pruneOldBackups/);
  assert.match(store, /snapshot_json = ''/);
  assert.match(store, /for \(const json of backupJsonChunks/);
  assert.match(store, /FROM json_each\(\?\)/);
});

test("paginates history independently from the small home-page activity summary", async () => {
  const [store, route, history] = await Promise.all([
    source("db/money-store.ts"),
    source("app/api/activities/route.ts"),
    source("app/history/page.tsx"),
  ]);

  assert.match(store, /getActivitiesPage/);
  assert.match(route, /export async function GET/);
  assert.match(store, /nextOffset/);
  assert.match(history, /載入更多（已顯示/);
  assert.match(history, /setTotal/);
});

test("never replaces a newer manual quote with an older official closing date", async () => {
  const store = await source("db/money-store.ts");
  assert.match(store, /quote\.asOf < holding\.quoteAsOf/);
  assert.match(store, /sale_date >= \?/);
  assert.doesNotMatch(store, /created_at >= \? LIMIT 1/);
});
