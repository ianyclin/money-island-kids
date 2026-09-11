// 暫時性自測用的最小 DOM／瀏覽器替身（jsc 沒有 DOM）。驗完即刪。
const noop = () => {};
const fakeElement = {
  innerHTML: "",
  textContent: "",
  addEventListener: noop,
  querySelector: () => null,
  querySelectorAll: () => [],
  focus: noop,
  remove: noop,
  insertAdjacentElement: noop,
  insertAdjacentHTML: noop,
  closest: () => null,
  matches: () => false,
  hasAttribute: () => false,
  getAttribute: () => null,
  setAttribute: noop,
  classList: { add: noop, remove: noop, contains: () => false },
  dataset: {},
  style: { setProperty: noop },
};

globalThis.document = {
  addEventListener: noop,
  removeEventListener: noop,
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ ...fakeElement }),
  documentElement: { ...fakeElement },
  hidden: false,
};

globalThis.window = globalThis;
globalThis.addEventListener = noop;
globalThis.removeEventListener = noop;
globalThis.setTimeout = (fn) => { void fn; return 0; };
globalThis.clearTimeout = noop;
globalThis.location = { hash: "#/parent", protocol: "http:", reload: noop };
globalThis.navigator = { userAgent: "jsc", standalone: false, maxTouchPoints: 0, platform: "MacIntel" };
globalThis.matchMedia = () => ({ matches: false, addEventListener: noop });

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)); },
  removeItem: (key) => { store.delete(key); },
  key: () => null,
  length: 0,
};
globalThis.indexedDB = undefined;
globalThis.crypto = globalThis.crypto || { getRandomValues: (array) => array, randomUUID: () => "00000000-0000-4000-8000-000000000000" };
globalThis.fetch = () => Promise.reject(new Error("no network in selftest"));
