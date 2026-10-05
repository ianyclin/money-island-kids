// 自我測試專用的 db.js 替身。selftest.html 用 importmap 把 ../js/db.js 指到這裡，
// 所以 store.js 匯入的 save 就是這一支；db.js 完成後不影響正式頁面。

export const KEY = "money-island.v1";
export const calls = [];
export const snapshots = [];          // takeSnapshot 收到的每一份：{ reason, raw, preRestore }

// 批 1 自我測試用的開關：模擬「localStorage 寫不進去」「IndexedDB 快照寫不進去」「帳本讀不出來」
export const control = { failSave: false, failSnapshot: false, broken: false, keepBroken: true, preserved: 0 };
let lastError = "";

export function save(state, reason) {
  calls.push({ reason, at: new Date().toISOString(), size: JSON.stringify(state).length });
  state.latestBackup = { id: "selftest-backup", reason, createdAt: new Date().toISOString(), copyStatus: "ready" };
  if (control.failSave) {
    lastError = "存不進去（測試）";
    state.backupHealth = { status: "failed", message: lastError };
    return false;
  }
  lastError = "";
  state.backupHealth = { status: "ready" };
  return true;
}

export function saveError() {
  return lastError;
}

export async function takeSnapshot(state, reason, options = {}) {
  const raw = JSON.stringify(state);
  await Promise.resolve();
  if (control.failSnapshot) return false;
  snapshots.push({ reason, raw, preRestore: Boolean(options.preRestore) });
  return true;
}

export function hasBrokenLedger() {
  return control.broken;
}

export function preserveBrokenLedger() {
  control.preserved += 1;
  return control.keepBroken;
}

export function setCloudBridge() {}

export function reset() {
  calls.length = 0;
  snapshots.length = 0;
  Object.assign(control, { failSave: false, failSnapshot: false, broken: false, keepBroken: true, preserved: 0 });
  lastError = "";
}

export function reasons() {
  return calls.map((call) => call.reason);
}

export function lastReason() {
  return calls.length ? calls[calls.length - 1].reason : "";
}
