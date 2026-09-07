"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { InfoTip } from "../info-tip";
import { clearMoneyStateCache, MoneyStateGate } from "../money-state-cache";
import { PrimaryNav } from "../primary-nav";

type AccessStatus = {
  configured: boolean;
  trusted: boolean;
  device: { id: string; label: string } | null;
  family?: { id: string; code: string; name: string } | null;
  legacyClaimAvailable?: boolean;
};

type Mode = "claim" | "join" | "create" | "recover";
type RecoveryMethod = "questions" | "key";

export default function FamilyAccessPage() {
  const [status, setStatus] = useState<AccessStatus>({ configured: false, trusted: false, device: null });
  const [mode, setMode] = useState<Mode>("join");
  const [recoveryMethod, setRecoveryMethod] = useState<RecoveryMethod>("questions");
  const [familyName, setFamilyName] = useState("");
  const [familyCode, setFamilyCode] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [parentPin, setParentPin] = useState("");
  const [profileNames, setProfileNames] = useState(["", "", ""]);
  const [deviceLabel, setDeviceLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ familyCode: string; recoveryCode: string } | null>(null);
  const [recoveredCode, setRecoveredCode] = useState("");
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    fetch("/api/device-access", { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json().catch(() => null) as (AccessStatus & { error?: string }) | null;
        if (!response.ok || !result) throw new Error(result?.error || "無法確認家庭登入狀態");
        setStatus(result);
        if (result.legacyClaimAvailable) setMode("claim");
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : "無法確認家庭登入狀態"))
      .finally(() => setChecking(false));
  }, []);

  async function post(payload: Record<string, unknown>) {
    const response = await fetch("/api/device-access", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json() as Record<string, unknown> & { error?: string };
    if (!response.ok) throw new Error(result.error || "操作失敗");
    return result;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "create" || mode === "claim") {
        const result = await post({ action: mode === "claim" ? "claim-existing" : "create-family", familyName, password, parentPin, deviceLabel });
        const family = result.family as { id: string; code: string; name: string };
        const recovery = String(result.recoveryCode ?? "");
        setCreated({ familyCode: family.code, recoveryCode: recovery });
        clearMoneyStateCache();
        setStatus({ configured: true, trusted: true, device: result.device as AccessStatus["device"], family });
      } else if (mode === "join") {
        const result = await post({ action: "login", familyCode, password, deviceLabel });
        clearMoneyStateCache();
        setStatus({ configured: true, trusted: true, device: result.device as AccessStatus["device"], family: result.family as AccessStatus["family"] });
      } else if (recoveryMethod === "key") {
        const result = await post({ action: "recover", recoveryCode, newPassword });
        const restoredFamilyCode = String(result.familyCode ?? "");
        const rotatedRecoveryCode = String(result.recoveryCode ?? "");
        setCreated({ familyCode: restoredFamilyCode, recoveryCode: rotatedRecoveryCode });
        setRecoveredCode(restoredFamilyCode);
        setFamilyCode(restoredFamilyCode);
        setPassword(newPassword);
        setNewPassword("");
        setRecoveryCode("");
        setMode("join");
      } else {
        const result = await post({ action: "recover-with-answers", profileNames, parentPin, newPassword, deviceLabel });
        const family = result.family as { id: string; code: string; name: string };
        const recovery = String(result.recoveryCode ?? "");
        setCreated({ familyCode: family.code, recoveryCode: recovery });
        clearMoneyStateCache();
        setStatus({ configured: true, trusted: true, device: result.device as AccessStatus["device"], family });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "操作失敗");
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    if (!window.confirm("要讓這台裝置離開目前家庭嗎？之後需要家庭代碼與密碼才能再次登入。")) return;
    setBusy(true);
    setError("");
    try {
      await post({ action: "logout" });
      clearMoneyStateCache();
      setStatus({ configured: false, trusted: false, device: null });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法離開家庭");
    } finally {
      setBusy(false);
    }
  }

  if (checking) return <MoneyStateGate />;

  return (
    <main className="access-shell">
      <header className="parent-topbar">
        <div className="access-brand-group">
          <Link className="brand" href="/"><span className="brand-mark" aria-hidden="true">¢</span><span><strong>小小理財島</strong><small>家庭入口</small></span></Link>
          {status.trusted && <span className="access-family-status"><i aria-hidden="true">✓</i><span><b>{status.family?.name}</b><small>已登入 · {status.device?.label}</small></span></span>}
        </div>
        <PrimaryNav />
      </header>
      <section className="access-hero is-single">
        <div><div className="heading-help"><span className="parent-kicker">每個家庭都有自己的帳本</span><InfoTip label="家庭入口說明">孩子不需要 ChatGPT 帳號。家庭代碼用來辨認帳本，家庭密碼只在登入新裝置時使用。OpenAI 的外層登入與家庭登入是兩件不同的事。</InfoTip></div><h1>建立一次，<br /><em>孩子的裝置就會一直記得。</em></h1></div>
      </section>

      {status.trusted ? (
        <section className="access-card">
          <span className="parent-kicker">家庭登入資訊</span><h2>{status.family?.name}</h2>
          <p>家庭代碼：<b>{status.family?.code}</b>。這台裝置會保持信任，直到家長撤銷或清除瀏覽器資料。</p>
          <div className="device-management-actions"><Link href="/">進入孩子首頁</Link><Link href="/parent">進入家長區</Link><button disabled={busy} onClick={() => void logout()}>{busy ? "離開中…" : "離開這個家庭"}</button></div>
          {created && <div className="trusted-explainer"><span>🔑</span><p><b>請現在抄下救援資料</b><br />家庭代碼：{created.familyCode}<br />離線救援碼：{created.recoveryCode}<br />救援碼之後不會再次完整顯示，建議寫在紙上由家長保管。</p></div>}
        </section>
      ) : (
        <section className="access-card">
          {mode === "claim" && <div className="legacy-claim-notice"><b>找到你原本的家庭帳本</b><span>這不是建立空白家庭。輸入現有家長操作碼後，原本的孩子資料會完整保留，系統再發給你正式家庭代碼。</span></div>}
          <div className="access-mode-tabs" aria-label="家庭入口功能">
            {status.legacyClaimAvailable && <button type="button" aria-pressed={mode === "claim"} className={mode === "claim" ? "is-active" : ""} onClick={() => setMode("claim")}>保留目前資料</button>}
            <button type="button" aria-pressed={mode === "join"} className={mode === "join" ? "is-active" : ""} onClick={() => setMode("join")}>登入家庭</button>
            <button type="button" aria-pressed={mode === "create"} className={mode === "create" ? "is-active" : ""} onClick={() => setMode("create")}>建立家庭</button>
            <button type="button" aria-pressed={mode === "recover"} className={mode === "recover" ? "is-active" : ""} onClick={() => setMode("recover")}>忘記代碼或密碼</button>
          </div>
          <form onSubmit={submit}>
            {(mode === "create" || mode === "claim") && <label>家庭名稱<input value={familyName} onChange={(event) => setFamilyName(event.target.value)} placeholder="例如：林家小島" required maxLength={30} /></label>}
            {mode === "join" && <label>家庭代碼<input value={familyCode} onChange={(event) => setFamilyCode(event.target.value.toUpperCase())} placeholder="MI-XXXXXX" required /></label>}
            {mode === "recover" ? <><div className="recovery-method-tabs" aria-label="選擇找回方式"><button type="button" aria-pressed={recoveryMethod === "questions"} className={recoveryMethod === "questions" ? "is-active" : ""} onClick={() => setRecoveryMethod("questions")}>用名稱＋家長操作碼</button><button type="button" aria-pressed={recoveryMethod === "key"} className={recoveryMethod === "key" ? "is-active" : ""} onClick={() => setRecoveryMethod("key")}>用離線救援碼</button></div>{recoveryMethod === "key" ? <><p className="recovery-help">救援碼本身已包含家庭識別資料，不需要另外輸入家庭代碼。</p><label>完整離線救援碼<input value={recoveryCode} onChange={(event) => setRecoveryCode(event.target.value.toUpperCase())} placeholder="MI-XXXXXX-XXXXXX-XXXXXX-XXXXXX" required /></label><label>新的家庭密碼<input type="password" minLength={8} maxLength={64} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="8–64 個字元" required /></label></> : <><p className="recovery-help">輸入三個孩子頁面目前顯示的名稱，順序不拘，再用家長操作碼確認。</p><div className="security-answer-grid">{profileNames.map((name, index) => <label key={index}>孩子頁面名稱 {index + 1}<input value={name} onChange={(event) => setProfileNames((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} placeholder={`小朋友 ${index + 1}`} required maxLength={30} /></label>)}</div><label>家長操作碼<input type="password" inputMode="numeric" pattern="[0-9]{4,8}" value={parentPin} onChange={(event) => setParentPin(event.target.value.replace(/\D/g, ""))} placeholder="4–8 位數字" required /></label><label>新的家庭密碼<input type="password" minLength={8} maxLength={64} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="8–64 個字元" required /></label></>}</> : <label>家庭密碼<input type="password" minLength={8} maxLength={64} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 8 個字元" required /></label>}
            {(mode === "create" || mode === "claim") && <label>{mode === "claim" ? "目前的家長操作碼" : "家長操作碼"}<input type="password" inputMode="numeric" pattern="[0-9]{4,8}" value={parentPin} onChange={(event) => setParentPin(event.target.value.replace(/\D/g, ""))} placeholder="4–8 位數字" required /></label>}
            {(mode !== "recover" || recoveryMethod === "questions") && <label>這台裝置名稱<input value={deviceLabel} onChange={(event) => setDeviceLabel(event.target.value)} placeholder="例如：客廳 iPad" required maxLength={40} /></label>}
            <button className="primary-button full-width" disabled={busy}>{busy ? "處理中…" : mode === "claim" ? "保留資料並取得家庭代碼" : mode === "create" ? "建立家庭帳本" : mode === "join" ? "登入並信任這台裝置" : recoveryMethod === "questions" ? "找回家庭並信任裝置" : "重設家庭密碼"}</button>
          </form>
          {recoveredCode && mode === "join" && <div className="legacy-claim-notice"><b>已找回家庭代碼：{recoveredCode}</b><span>新密碼已設定完成。現在輸入裝置名稱，即可重新信任這台裝置。</span></div>}
          {recoveredCode && created?.recoveryCode && <div className="trusted-explainer"><span>🔑</span><p><b>請抄下新的離線救援碼</b><br />{created.recoveryCode}<br />舊救援碼與原本信任的裝置已停用；這組新救援碼之後不會再次完整顯示。</p></div>}
        </section>
      )}
      {error && <p className="access-error" role="alert">{error}</p>}
    </main>
  );
}
