"use client";

import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import type { MoneyState } from "../money-types";

type Device = { id: string; label: string; createdAt: string; lastUsedAt: string; revokedAt: string | null };
type AccessStatus = {
  configured: boolean;
  trusted: boolean;
  device: Device | null;
  family?: { id: string; code: string; name: string } | null;
};
type RestoreSummary = {
  family: { name: string; code: string };
  exportedAt: string;
  counts: { profiles: number; activities: number; dreams: number; holdings: number; reflections: number };
  portable: boolean;
  photoCount: number;
};

export function DeviceTrustPanel({
  parentPin,
  unlocked,
  onDownloadBackup,
  onDownloadPortableBackup,
  onRestore,
}: {
  parentPin: string;
  unlocked: boolean;
  onDownloadBackup: () => void;
  onDownloadPortableBackup: () => void;
  onRestore: (state: MoneyState) => void;
}) {
  const [status, setStatus] = useState<AccessStatus>({ configured: false, trusted: false, device: null });
  const [devices, setDevices] = useState<Device[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [familyName, setFamilyName] = useState("我的家庭");
  const [familyPassword, setFamilyPassword] = useState("");
  const [accountResult, setAccountResult] = useState<{ code: string; recoveryCode: string } | null>(null);
  const [backupFile, setBackupFile] = useState<File | null>(null);
  const [restoreSummary, setRestoreSummary] = useState<RestoreSummary | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/device-access").then((response) => response.json()).then((result: AccessStatus) => {
      setStatus(result);
      if (result.family?.name) setFamilyName(result.family.name);
    }).catch(() => undefined);
  }, []);

  async function post(payload: Record<string, unknown>) {
    const response = await fetch("/api/device-access", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const result = await response.json() as Record<string, unknown> & { error?: string; devices?: Device[] };
    if (!response.ok) throw new Error(result.error || "裝置操作失敗");
    return result;
  }

  async function configureAccount(event: FormEvent) {
    event.preventDefault(); setBusy("account"); setError("");
    try {
      const result = await post({ action: "configure-existing", familyName, password: familyPassword, parentPin });
      const family = result.family as { id: string; code: string; name: string };
      setStatus({ ...status, family });
      setAccountResult({ code: family.code, recoveryCode: String(result.recoveryCode ?? "") });
      setFamilyPassword("");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "設定失敗"); }
    finally { setBusy(""); }
  }

  async function loadDevices() {
    setBusy("list"); setError("");
    try { const result = await post({ action: "list", parentPin }); setDevices(result.devices ?? []); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "讀取失敗"); }
    finally { setBusy(""); }
  }

  async function revoke(deviceId: string) {
    const device = devices.find((item) => item.id === deviceId);
    const isCurrentDevice = status.device?.id === deviceId;
    const warning = isCurrentDevice
      ? `「${device?.label ?? "這台裝置"}」就是目前正在使用的裝置。撤銷後會失去家庭存取權，確定繼續嗎？`
      : `確定要撤銷「${device?.label ?? "這台裝置"}」嗎？之後需要家庭代碼與密碼才能重新登入。`;
    if (!window.confirm(warning)) return;
    setBusy(deviceId); setError("");
    try { await post({ action: "revoke", deviceId, parentPin }); setDevices((current) => current.map((item) => item.id === deviceId ? { ...item, revokedAt: new Date().toISOString() } : item)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "撤銷失敗"); }
    finally { setBusy(""); }
  }

  async function inspectBackup(file: File) {
    setBackupFile(file); setRestoreSummary(null); setBusy("inspect"); setError("");
    try {
      const form = new FormData(); form.set("action", "inspect"); form.set("file", file);
      const response = await fetch("/api/backups", { method: "POST", body: form });
      const result = await response.json() as { error?: string; summary?: RestoreSummary };
      if (!response.ok || !result.summary) throw new Error(result.error || "無法讀取備份檔");
      setRestoreSummary(result.summary);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "無法讀取備份檔"); }
    finally { setBusy(""); }
  }

  async function restoreBackup() {
    if (!backupFile || !restoreSummary) return;
    const warning = restoreSummary.portable
      ? "完整可攜備份會取代目前家庭的帳本與孩子照片。系統會先保存目前帳本版本，確定繼續嗎？"
      : "這份備份會取代目前帳本。系統會先保存目前版本，確定繼續嗎？";
    if (!window.confirm(warning)) return;
    setBusy("restore"); setError("");
    try {
      const form = new FormData();
      form.set("action", "restore"); form.set("file", backupFile); form.set("parentPin", parentPin); form.set("confirm", "RESTORE");
      const response = await fetch("/api/backups", { method: "POST", body: form });
      const result = await response.json() as { error?: string; state?: MoneyState };
      if (!response.ok || !result.state) throw new Error(result.error || "還原失敗");
      onRestore(result.state); setBackupFile(null); setRestoreSummary(null); if (fileRef.current) fileRef.current.value = "";
    } catch (caught) { setError(caught instanceof Error ? caught.message : "還原失敗"); }
    finally { setBusy(""); }
  }

  const needsAccountUpgrade = status.family?.code === "MY-FAMILY";
  return (
    <section className="parent-device-panel" id="devices">
      <div className="parent-device-heading"><div><span className="parent-kicker">裝置與資料</span><h2>家庭帳戶與備份</h2></div><span className={status.trusted ? "device-status is-trusted" : "device-status"}>{status.trusted ? "✓ 本機已信任" : "尚未登入家庭"}</span></div>
      <div className="parent-device-grid">
        {needsAccountUpgrade && <details open><summary>完成多家庭帳戶設定</summary><p>為目前帳本建立家庭代碼與家庭密碼，資料不會搬動或遺失。</p><form onSubmit={configureAccount}><label>家庭名稱<input value={familyName} onChange={(event) => setFamilyName(event.target.value)} required maxLength={30} /></label><label>家庭密碼<input type="password" minLength={8} maxLength={64} value={familyPassword} onChange={(event) => setFamilyPassword(event.target.value)} required /></label><button disabled={!unlocked || busy === "account"}>{busy === "account" ? "設定中…" : "建立家庭登入資料"}</button></form>{accountResult && <p><b>家庭代碼：{accountResult.code}</b><br />離線救援碼：{accountResult.recoveryCode}<br />請寫在紙上安全保管，之後不會再次完整顯示。</p>}</details>}
        <details><summary>管理信任裝置</summary><p>{status.family ? `${status.family.name} · ${status.family.code}` : "這台裝置尚未登入家庭"}</p><button disabled={!unlocked || busy === "list"} onClick={() => void loadDevices()}>{busy === "list" ? "讀取中…" : "查看所有裝置"}</button><Link href="/family-access">家庭入口</Link>{devices.length > 0 && <div className="device-list">{devices.map((device) => { const isCurrentDevice = status.device?.id === device.id; return <div key={device.id} className={[device.revokedAt ? "is-revoked" : "", isCurrentDevice ? "is-current" : ""].filter(Boolean).join(" ")}><span><b>{device.label}{isCurrentDevice && <em className="device-current-badge">這台裝置</em>}</b><small>{device.revokedAt ? "已撤銷" : `上次使用 ${new Date(device.lastUsedAt).toLocaleDateString("zh-TW")}`}</small></span><button disabled={Boolean(device.revokedAt) || busy === device.id} aria-label={`${device.revokedAt ? "已停用" : "撤銷"}裝置「${device.label}」${isCurrentDevice ? "（這台裝置）" : ""}`} onClick={() => void revoke(device.id)}>{device.revokedAt ? "已停用" : busy === device.id ? "撤銷中…" : "撤銷"}</button></div>; })}</div>}</details>
        <details><summary>下載或上傳資料副本</summary><p>平時可下載帳本；搬到另一個部署時，請下載包含孩子照片的完整可攜備份。兩種備份都不含密碼、家長操作碼或裝置信任。</p><div className="backup-download-actions"><button disabled={!unlocked} onClick={onDownloadBackup}>下載帳本備份</button><button disabled={!unlocked} onClick={onDownloadPortableBackup}>下載完整可攜備份</button></div><label className="backup-file-label">選擇備份檔<input ref={fileRef} type="file" accept="application/json,.json" disabled={!unlocked || busy === "restore"} onChange={(event) => { const file = event.target.files?.[0]; if (file) void inspectBackup(file); }} /></label>{busy === "inspect" && <p>正在檢查備份內容…</p>}{restoreSummary && <div className="restore-summary"><b>{restoreSummary.family.name} · {new Date(restoreSummary.exportedAt).toLocaleString("zh-TW")}</b><small>{restoreSummary.portable ? `完整可攜備份${restoreSummary.photoCount ? `，包含 ${restoreSummary.photoCount} 張照片` : ""}` : "同家庭帳本備份"}</small><small>{restoreSummary.counts.profiles} 位孩子、{restoreSummary.counts.activities} 筆紀錄、{restoreSummary.counts.dreams} 個夢想、{restoreSummary.counts.holdings} 個投資標的</small><button className="restore-button" disabled={!unlocked || busy === "restore"} onClick={() => void restoreBackup()}>{busy === "restore" ? "還原中…" : "確認覆蓋並還原"}</button><small>確認後會先自動保存目前帳本，再以備份內容取代。</small></div>}</details>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}
