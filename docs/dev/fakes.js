// 自我測試專用的假 localStorage、假 IndexedDB、假 fetch（批 1 資料安全）。
// selftest.html 跟正式 app 同一個網域：直接用真的 localStorage／IndexedDB 會動到家裡那份帳本與快照，
// 所以整輪測試期間把 window.localStorage、window.indexedDB 換成這裡的替身，跑完再換回來。
// 只實作 db.js、pin.js、gist.js 用得到的那幾個方法。

// ---------- localStorage ----------
export function createFakeStorage() {
  const map = new Map();
  const storage = {
    quota: Infinity,                 // 字元數上限；測「容量滿了」時調小
    get length() { return map.size; },
    key(index) { return [...map.keys()][index] ?? null; },
    getItem(key) { key = String(key); return map.has(key) ? map.get(key) : null; },
    setItem(key, value) {
      key = String(key);
      value = String(value);
      let used = key.length + value.length;
      for (const [other, stored] of map) if (other !== key) used += other.length + stored.length;
      if (used > storage.quota) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      map.set(key, value);
    },
    removeItem(key) { map.delete(String(key)); },
    clear() { map.clear(); },
    keys() { return [...map.keys()]; },
  };
  return storage;
}

// ---------- IndexedDB ----------
// 交易與請求都用 setTimeout 非同步觸發，順序跟瀏覽器一樣是先 request.onsuccess、後 transaction.oncomplete。
export function createFakeIndexedDB() {
  const databases = new Map();
  const control = { failOpen: false, failWrites: false, failReads: false };
  const later = (fn) => setTimeout(fn, 0);
  const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  function makeDatabase(record) {
    return {
      objectStoreNames: { contains: (name) => record.stores.has(name) },
      createObjectStore(name, options = {}) {
        record.stores.set(name, { keyPath: options.keyPath, data: new Map() });
      },
      close() {},
      transaction(name, mode = "readonly") {
        const store = record.stores.get(name);
        if (!store) throw new DOMException("No objectStore named " + name, "NotFoundError");
        const tx = { oncomplete: null, onerror: null, onabort: null };
        let failed = false;
        let finishing = false;
        const finish = () => {
          if (finishing) return;
          finishing = true;
          later(() => later(() => {
            if (failed) { if (tx.onerror) tx.onerror(); if (tx.onabort) tx.onabort(); }
            else if (tx.oncomplete) tx.oncomplete();
          }));
        };
        const request = (work) => {
          const req = { onsuccess: null, onerror: null, result: undefined, error: null };
          later(() => {
            try {
              req.result = work();
              if (req.onsuccess) req.onsuccess({ target: req });
            } catch (error) {
              failed = true;
              req.error = error;
              if (req.onerror) req.onerror({ target: req });
            }
          });
          finish();
          return req;
        };
        const writable = () => {
          if (mode !== "readwrite") throw new DOMException("readonly transaction", "ReadOnlyError");
          if (control.failWrites) throw new DOMException("寫入失敗（測試）", "UnknownError");
        };
        tx.objectStore = () => ({
          put(value) { return request(() => { writable(); const key = value[store.keyPath]; store.data.set(key, structuredClone(value)); return key; }); },
          get(key) { return request(() => { const value = store.data.get(key); return value === undefined ? undefined : structuredClone(value); }); },
          delete(key) { return request(() => { writable(); store.data.delete(key); }); },
          openCursor(range, direction) {
            const keys = [...store.data.keys()].sort(compare);
            if (direction === "prev") keys.reverse();
            let index = 0;
            const req = { onsuccess: null, onerror: null, result: null };
            if (control.failReads) {      // 批 1 驗收 #8：模擬瀏覽器資料庫讀到一半出錯
              later(() => { if (req.onerror) req.onerror({ target: req }); });
              return req;
            }
            const step = () => later(() => {
              if (index >= keys.length) { req.result = null; if (req.onsuccess) req.onsuccess({ target: req }); return; }
              const key = keys[index];
              index += 1;
              req.result = { key, value: structuredClone(store.data.get(key)), continue: step };
              if (req.onsuccess) req.onsuccess({ target: req });
            });
            step();
            return req;
          },
        });
        return tx;
      },
    };
  }

  return {
    control,
    open(name) {
      const req = { onupgradeneeded: null, onsuccess: null, onerror: null, result: null };
      later(() => {
        if (control.failOpen) { if (req.onerror) req.onerror(); return; }
        let record = databases.get(name);
        const fresh = !record;
        if (!record) { record = { stores: new Map() }; databases.set(name, record); }
        req.result = makeDatabase(record);
        if (fresh && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
    // 測試直接看資料庫裡剩什麼
    dump(name, storeName) {
      const record = databases.get(name);
      const store = record && record.stores.get(storeName);
      return store ? [...store.data.values()].map((value) => structuredClone(value)) : [];
    },
  };
}

// ---------- 換掉／換回 window 上的 localStorage 與 indexedDB ----------
export function installStorageFakes() {
  const saved = {};
  for (const name of ["localStorage", "indexedDB"]) saved[name] = Object.getOwnPropertyDescriptor(window, name);
  const storage = createFakeStorage();
  const idb = createFakeIndexedDB();
  Object.defineProperty(window, "localStorage", { value: storage, configurable: true, writable: true });
  Object.defineProperty(window, "indexedDB", { value: idb, configurable: true, writable: true });
  return {
    storage,
    idb,
    restore() {
      for (const [name, descriptor] of Object.entries(saved)) {
        if (descriptor) Object.defineProperty(window, name, descriptor);
        else delete window[name];
      }
    },
  };
}

// ---------- fetch ----------
// handler(url, options, calls) 回傳 Response（或丟錯）。calls 記下每一次請求的網址與方法。
export function installFakeFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: String(options.method || "GET").toUpperCase(), body: options.body };
    calls.push(call);
    return handler(call.url, options, calls);
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

export function jsonResponse(status, body) {
  return new Response(status === 204 ? null : JSON.stringify(body ?? {}), {
    status,
    headers: { "content-type": "application/json" },
  });
}
