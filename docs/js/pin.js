// 小小理財島 PWA：家長操作碼。
// 規則來源：db/money-store.ts hashPin L202–216、setParentPin L739–752、
// recordFailedParentPin L724–737、assertParentPin L754–774、changeParentPin L776–786。
// 單機版把 family_security 資料表換成 localStorage["money-island.v1.security"]。

import { bytesToHex, hexToBytes } from "./util.js";

const STORAGE_KEY = "money-island.v1.security";
const PBKDF2_ITERATIONS = 100000;      // money-store.ts L163
const PIN_MAX_FAILED_ATTEMPTS = 5;     // money-store.ts L164
const PIN_LOCK_MS = 15 * 60000;        // money-store.ts L165

// 本次開啟期間的解鎖狀態；不寫進任何儲存。
let unlockedPin = "";

function readSecurity() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof parsed.salt !== "string" || typeof parsed.hash !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeSecurity(record) {
  globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(record));
}

// money-store.ts hashPin L202–216
async function hashPin(pin, salt) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    material,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

function isLocked(record) {
  return Boolean(record?.lockedUntil && Date.parse(record.lockedUntil) > Date.now());
}

// money-store.ts recordFailedParentPin L724–737：第 5 次失敗時計數歸零並上鎖 15 分鐘。
function recordFailedParentPin(record) {
  const failedAttempts = Number(record.failedAttempts ?? 0);
  const reachedLimit = failedAttempts >= PIN_MAX_FAILED_ATTEMPTS - 1;
  const next = {
    ...record,
    failedAttempts: reachedLimit ? 0 : failedAttempts + 1,
    lockedUntil: reachedLimit ? new Date(Date.now() + PIN_LOCK_MS).toISOString() : null,
  };
  writeSecurity(next);
  return isLocked(next);
}

export function isConfigured() {
  return Boolean(readSecurity());
}

export function status() {
  if (!readSecurity()) return "setup";
  return unlockedPin ? "unlocked" : "locked";
}

export function isUnlocked() {
  return Boolean(unlockedPin);
}

export function lock() {
  unlockedPin = "";
}

// money-store.ts setParentPin L739–752
export async function setup(pin) {
  if (!/^\d{4,8}$/.test(pin)) throw new Error("操作碼請使用 4 到 8 位數字");
  if (readSecurity()) throw new Error("家長操作碼已經設定");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await hashPin(pin, salt);
  writeSecurity({
    salt: bytesToHex(salt),
    hash,
    iterations: PBKDF2_ITERATIONS,
    failedAttempts: 0,
    lockedUntil: null,
    updatedAt: new Date().toISOString(),
  });
  unlockedPin = pin;
}

// money-store.ts assertParentPin L754–774。
// 單機版差異：本次開啟期間解鎖成功後，UI 可以不再重送操作碼；沒帶 pin 時改用記住的那一組再驗一次。
export async function assert(pin) {
  const record = readSecurity();
  if (!record) throw new Error("請先設定家長操作碼");
  const candidatePin = pin || unlockedPin;
  if (!candidatePin || !/^\d{4,8}$/.test(candidatePin)) throw new Error("請輸入家長操作碼");
  if (isLocked(record)) throw new Error("嘗試次數過多，請 15 分鐘後再試");
  const candidate = await hashPin(candidatePin, hexToBytes(record.salt));
  if (candidate !== record.hash) {
    if (candidatePin === unlockedPin) unlockedPin = "";
    const locked = recordFailedParentPin(record);
    throw new Error(locked ? "嘗試次數過多，請 15 分鐘後再試" : "家長操作碼不正確");
  }
  if (record.failedAttempts || record.lockedUntil) {
    writeSecurity({ ...record, failedAttempts: 0, lockedUntil: null, updatedAt: new Date().toISOString() });
  }
  unlockedPin = candidatePin;
}

// money-store.ts changeParentPin L776–786
export async function change(currentPin, newPin) {
  await assert(currentPin);
  if (!/^\d{4,8}$/.test(newPin)) throw new Error("新操作碼請使用 4 到 8 位數字");
  if (currentPin === newPin) throw new Error("新操作碼需與目前操作碼不同");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await hashPin(newPin, salt);
  writeSecurity({
    salt: bytesToHex(salt),
    hash,
    iterations: PBKDF2_ITERATIONS,
    failedAttempts: 0,
    lockedUntil: null,
    updatedAt: new Date().toISOString(),
  });
  unlockedPin = newPin;
}

// store.js 用的別名：需要家長操作碼的函式一律 await assertParentPin(parentPin)。
export const assertParentPin = assert;
