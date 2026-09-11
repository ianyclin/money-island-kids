// 自我測試專用的 db.js 替身。selftest.html 用 importmap 把 ../js/db.js 指到這裡，
// 所以 store.js 匯入的 save 就是這一支；db.js 完成後不影響正式頁面。

export const calls = [];

export function save(state, reason) {
  calls.push({ reason, at: new Date().toISOString(), size: JSON.stringify(state).length });
  state.latestBackup = { id: "selftest-backup", reason, createdAt: new Date().toISOString(), copyStatus: "ready" };
  state.backupHealth = { status: "ready" };
}

export function reset() {
  calls.length = 0;
}

export function reasons() {
  return calls.map((call) => call.reason);
}

export function lastReason() {
  return calls.length ? calls[calls.length - 1].reason : "";
}
