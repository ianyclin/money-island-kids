// 小小理財島 PWA：匯出／檢查／還原／分享。
// 規則來源：db/money-store.ts createBackupEnvelope L3051–3063、createPortableBackupEnvelope L3089–3124、
// validatePortableBackupEnvelope L3458–3495、inspectBackupEnvelope L3497–3522、
// restoreBackupEnvelope L3678–3813（持股彙總重算 L3792–3806）。
// 分享／下載照 ../stamps/index.html 3858–3879。
//
// 單機版差異：照片不再放 R2，改成 state 裡的 data URL 頭像；
// 舊站的完整可攜備份（photos[] ＋ "/api/profile-photo" 頭像）可以直接匯入。

import { nowIso, roundUnits } from "./util.js";
import {
  MAX_PORTABLE_PHOTO_BYTES,
  MAX_PORTABLE_PHOTO_TOTAL_BYTES,
  PORTABLE_PHOTO_TYPES,
  addBackupUnique,
  backupEnum,
  backupId,
  backupRecord,
  backupString,
  invalidBackup,
  normalize,
  validateBackupEnvelope,
} from "./state.js";
import { setState } from "./store.js";

const PHOTO_MAX_EDGE = 256;
const PHOTO_QUALITY = 0.82;
const PHOTO_RETRY_QUALITY = 0.5;
const PHOTO_MAX_DATA_URL_CHARS = 60000;

// ---------- base64 ----------

// money-store.ts bytesToBase64 L3065–3072
function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 32768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

// money-store.ts base64ToBytes L3074–3087
function base64ToBytes(value) {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    invalidBackup("照片內容格式錯誤");
  }
  let binary;
  try {
    binary = atob(value);
  } catch {
    invalidBackup("照片內容格式錯誤");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function base64ByteLength(value) {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor(value.length * 3 / 4) - padding;
}

function parseDataUrl(value) {
  const match = /^data:([a-z/+.-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(String(value));
  if (!match) return null;
  return { contentType: match[1].toLowerCase(), base64: match[2] };
}

// ---------- 匯出 ----------

function exportableState(state) {
  if (!state?.family) throw new Error("找不到這個家庭帳本");
  return JSON.parse(JSON.stringify(state));
}

// money-store.ts createBackupEnvelope L3051–3063
export function exportEnvelope(state) {
  const copy = exportableState(state);
  return {
    format: "money-island-backup",
    version: 1,
    exportedAt: nowIso(),
    family: copy.family,
    state: copy,
  };
}

// money-store.ts createPortableBackupEnvelope L3089–3124
// 頭像是 data URL 的孩子會被抽成 photos[]，state 內改寫成舊站相容的 "/api/profile-photo?profileId=<id>"。
export function exportPortableEnvelope(state) {
  const copy = exportableState(state);
  const photos = [];
  let totalPhotoBytes = 0;
  for (const profile of copy.profiles) {
    const parsed = parseDataUrl(profile.avatar);
    if (!parsed) continue;
    if (!PORTABLE_PHOTO_TYPES.includes(parsed.contentType)) {
      throw new Error(`${profile.name}的照片格式不支援完整備份`);
    }
    const bytes = base64ByteLength(parsed.base64);
    if (!bytes || bytes > MAX_PORTABLE_PHOTO_BYTES) throw new Error(`${profile.name}的照片大小不符合限制`);
    totalPhotoBytes += bytes;
    if (totalPhotoBytes > MAX_PORTABLE_PHOTO_TOTAL_BYTES) throw new Error("照片總容量過大，請縮小照片後再製作完整備份");
    photos.push({ profileId: profile.id, contentType: parsed.contentType, base64: parsed.base64 });
    profile.avatar = `/api/profile-photo?profileId=${encodeURIComponent(profile.id)}`;
  }
  return {
    format: "money-island-portable-backup",
    version: 1,
    exportedAt: nowIso(),
    family: copy.family,
    state: copy,
    photos,
  };
}

// ---------- 檢查 ----------

// money-store.ts validatePortableBackupEnvelope L3458–3495
export function validatePortableEnvelope(value) {
  const root = backupRecord(value, "完整可攜備份");
  if (root.format !== "money-island-portable-backup" || root.version !== 1) {
    throw new Error("完整可攜備份版本不支援，請使用網站最新下載的 JSON 檔案");
  }
  const standardEnvelope = {
    format: "money-island-backup",
    version: 1,
    exportedAt: root.exportedAt,
    family: root.family,
    state: root.state,
  };
  validateBackupEnvelope(standardEnvelope);
  if (!Array.isArray(root.photos) || root.photos.length > standardEnvelope.state.profiles.length) {
    invalidBackup("照片清單格式錯誤");
  }
  const profileIds = new Set(standardEnvelope.state.profiles.map((profile) => profile.id));
  const photoProfiles = new Set();
  let totalPhotoBytes = 0;
  for (const rawPhoto of root.photos) {
    const photo = backupRecord(rawPhoto, "孩子照片");
    const profileId = backupId(photo.profileId, "照片孩子 ID");
    if (!profileIds.has(profileId)) invalidBackup("照片連到不存在的孩子");
    addBackupUnique(photoProfiles, profileId, "孩子照片");
    const contentType = backupEnum(photo.contentType, "照片格式", PORTABLE_PHOTO_TYPES);
    const base64 = backupString(photo.base64, "照片內容", 4, Math.ceil(MAX_PORTABLE_PHOTO_BYTES * 4 / 3) + 8);
    const bytes = base64ToBytes(base64);
    if (!bytes.length || bytes.length > MAX_PORTABLE_PHOTO_BYTES) invalidBackup("照片大小不符合限制");
    totalPhotoBytes += bytes.length;
    if (totalPhotoBytes > MAX_PORTABLE_PHOTO_TOTAL_BYTES) invalidBackup("照片總容量超過限制");
    if (!PORTABLE_PHOTO_TYPES.includes(contentType)) invalidBackup("照片格式不支援");
  }
  for (const profile of standardEnvelope.state.profiles) {
    if (profile.avatar.startsWith("/api/profile-photo") && !photoProfiles.has(profile.id)) {
      invalidBackup(`${profile.name}缺少照片內容`);
    }
  }
  return root;
}

export function isPortableEnvelope(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && value.format === "money-island-portable-backup");
}

// money-store.ts inspectBackupEnvelope L3497–3522
export function inspect(parsed) {
  const portable = isPortableEnvelope(parsed);
  if (portable) validatePortableEnvelope(parsed);
  else validateBackupEnvelope(parsed);
  return {
    family: parsed.family,
    exportedAt: parsed.exportedAt,
    counts: {
      profiles: parsed.state.profiles.length,
      activities: parsed.state.activities.length,
      dreams: parsed.state.dreamJars.length,
      holdings: parsed.state.holdings.length,
      reflections: parsed.state.reflections.length,
    },
    portable,
    photoCount: portable ? parsed.photos.length : 0,
  };
}

// ---------- 照片壓縮 ----------

function hasImageSupport() {
  return typeof document !== "undefined" && typeof Image !== "undefined" && typeof document.createElement === "function";
}

// 契約第 3 節：最長邊 256px、JPEG 0.82；超過 60,000 字元再以 0.5 重壓。
// 沒有 DOM 的環境（例如自我測試在 Node 下跑）就原樣保留，不做壓縮。
export async function compressPhotoToDataUrl(source) {
  if (!hasImageSupport()) return source;
  const image = await new Promise((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("照片讀不出來，請換一張試試"));
    element.src = source;
  });
  const longestEdge = Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height) || PHOTO_MAX_EDGE;
  const scale = Math.min(1, PHOTO_MAX_EDGE / longestEdge);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
  canvas.height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  let dataUrl = canvas.toDataURL("image/jpeg", PHOTO_QUALITY);
  if (dataUrl.length > PHOTO_MAX_DATA_URL_CHARS) dataUrl = canvas.toDataURL("image/jpeg", PHOTO_RETRY_QUALITY);
  return dataUrl;
}

// ---------- 還原 ----------

// money-store.ts restoreBackupEnvelope L3792–3806：持股彙總一律從 holdings 重算。
function recomputeInvestmentTotals(state) {
  for (const profile of state.profiles) {
    const owned = state.holdings.filter((holding) => holding.profileId === profile.id);
    profile.marketValue = owned.reduce((sum, holding) => sum + Math.round(holding.marketValue), 0);
    profile.stockCost = owned.reduce((sum, holding) => sum + Math.round(holding.costBasis), 0);
    profile.stockUnits = roundUnits(owned.reduce((sum, holding) => sum + holding.units, 0));
    const first = [...owned].sort((a, b) =>
      (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
    profile.stockCode = first ? first.symbol : null;
    const synced = owned
      .map((holding) => holding.priceUpdatedAt ?? holding.updatedAt)
      .filter(Boolean)
      .sort();
    profile.lastSyncedAt = synced.length ? synced[synced.length - 1] : null;
  }
}

// 契約第 8 節：舊站的完整可攜備份可以直接匯入。
// photos → data URL 頭像（有 DOM 就重新壓縮）；"/api/profile-photo" 頭像找不到照片就用 "🙂"。
export async function restore(parsed) {
  const portable = isPortableEnvelope(parsed);
  if (portable) validatePortableEnvelope(parsed);
  else validateBackupEnvelope(parsed);

  const source = JSON.parse(JSON.stringify(parsed.state));
  source.family = source.family ?? parsed.family;
  if (portable) {
    const photos = new Map(parsed.photos.map((photo) => [photo.profileId, photo]));
    for (const profile of source.profiles) {
      const photo = photos.get(profile.id);
      if (photo) {
        profile.avatar = await compressPhotoToDataUrl(`data:${photo.contentType};base64,${photo.base64}`);
      } else if (String(profile.avatar).startsWith("/api/profile-photo")) {
        profile.avatar = "🙂";
      }
    }
  } else {
    for (const profile of source.profiles) {
      if (String(profile.avatar).startsWith("/api/profile-photo")) profile.avatar = "🙂";
    }
  }

  recomputeInvestmentTotals(source);
  source.latestBackup = null;
  source.backupHealth = { status: "pending", message: "等待還原後建立新的備份" };
  const state = normalize(source);
  return setState(state, "已由上傳檔案還原");
}

// ---------- 分享／下載 ----------

// ../stamps/index.html 3858–3879：先試分享表（iOS 主畫面 app 沒有下載管理器），
// 再試 <a download>，最後複製到剪貼簿。
export async function shareOrDownload(json, filename) {
  const text = typeof json === "string" ? json : JSON.stringify(json, null, 1);
  try {
    if (typeof File !== "undefined" && navigator.canShare) {
      const file = new File([text], filename, { type: "application/json" });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: "小小理財島備份" });
        return "share";
      }
    }
  } catch (error) {
    if (error && error.name === "AbortError") return "cancelled";
  }
  try {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return "download";
  } catch {
    await navigator.clipboard.writeText(text);
    return "clipboard";
  }
}

export function backupFileName(state, { portable = false } = {}) {
  const day = new Date().toISOString().slice(0, 10);
  const name = String(state?.family?.name ?? "小小理財島").replace(/[\\/:*?"<>|\s]+/g, "-");
  return `${name}-${portable ? "完整備份" : "帳本備份"}-${day}.json`;
}
