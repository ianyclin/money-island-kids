"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { InfoTip } from "../info-tip";
import { MoneyStateGate, moneyThemeStyle, revalidateMoneyState, setMoneyStateCache, useMoneyStateCache, useSelectedProfile } from "../money-state-cache";
import type { DreamJar, MoneyState } from "../money-types";
import { PrimaryNav } from "../primary-nav";
import { ProfileAvatar } from "../profile-avatar";

const money = new Intl.NumberFormat("zh-TW", { style: "currency", currency: "TWD", maximumFractionDigits: 0 });
const currentMonth = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit" }).format(new Date());

export default function DreamsPage() {
  const { state, error: stateError } = useMoneyStateCache();
  const { profile, chooseProfile: selectProfile } = useSelectedProfile(state?.profiles ?? []);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"short" | "long">("short");
  const [targetAmount, setTargetAmount] = useState("");
  const [editingId, setEditingId] = useState("");
  const [proudText, setProudText] = useState("");
  const [changeText, setChangeText] = useState("");
  const [planText, setPlanText] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("夢想與回顧都會自動備份");
  const [pinStatus, setPinStatus] = useState<"loading" | "setup" | "locked" | "unlocked">("loading");
  const [parentPin, setParentPin] = useState("");
  const [pinError, setPinError] = useState("");
  const [completedEditor, setCompletedEditor] = useState<DreamJar | null>(null);
  const [completedEditTitle, setCompletedEditTitle] = useState("");
  const [completedEditKind, setCompletedEditKind] = useState<"short" | "long">("short");
  const [completedEditTarget, setCompletedEditTarget] = useState("");
  const [completedEditAmount, setCompletedEditAmount] = useState("");
  const [completedEditStartedAt, setCompletedEditStartedAt] = useState("");
  const [completedEditFinishedAt, setCompletedEditFinishedAt] = useState("");
  const [completedEditError, setCompletedEditError] = useState("");
  const [selectedMonth, setSelectedMonth] = useState(currentMonth);

  useEffect(() => {
    fetch("/api/parent-pin", { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json().catch(() => null) as { configured?: boolean; error?: string } | null;
        if (response.status === 401) { window.location.replace("/family-access"); return; }
        if (!response.ok) throw new Error(result?.error || "無法讀取家長操作碼狀態");
        setPinStatus(result?.configured ? "locked" : "setup");
      })
      .catch(() => setPinStatus("locked"));
  }, []);

  const jars = useMemo(() => state && profile ? state.dreamJars.filter((item) => item.profileId === profile.id) : [], [profile, state]);
  const activeShort = jars.find((item) => item.status === "active" && item.kind === "short");
  const activeLong = jars.find((item) => item.status === "active" && item.kind === "long");
  const queuedShort = jars.filter((item) => item.status === "queued" && item.kind === "short");
  const completedJars = jars.filter((item) => item.status === "completed");
  const availableMonths = useMemo(() => {
    const keys = new Set(recentMonthKeys(12));
    for (const item of state?.activities ?? []) if (item.profileId === profile?.id) keys.add(item.entryDate.slice(0, 7));
    for (const item of state?.reflections ?? []) if (item.profileId === profile?.id) keys.add(item.month);
    return [...keys].filter((item) => /^\d{4}-\d{2}$/.test(item)).sort((a, b) => b.localeCompare(a));
  }, [profile?.id, state?.activities, state?.reflections]);
  const reflection = state?.reflections.find((item) => item.profileId === profile?.id && item.month === selectedMonth);
  const monthActivities = (state?.activities ?? []).filter((item) => item.profileId === profile?.id && item.entryDate.startsWith(selectedMonth));
  const monthSpend = monthActivities.filter((item) => item.kind === "spend").reduce((sum, item) => sum + item.amount, 0);
  const monthSpendCount = monthActivities.filter((item) => item.kind === "spend").length;
  const monthSaved = monthActivities.filter((item) => ["allowance", "project", "sheet-deposit", "savings-transfer"].includes(item.kind)).reduce((sum, item) => sum + Math.max(0, item.bankDelta), 0);
  const monthVoluntarySaved = monthActivities.filter((item) => item.kind === "savings-transfer").reduce((sum, item) => sum + item.amount, 0);
  const monthAssetChange = monthActivities.reduce((sum, item) => sum + item.spendDelta + item.bankDelta + item.marketDelta, 0);
  const selectedMonthIndex = Math.max(0, availableMonths.indexOf(selectedMonth));

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setProudText(reflection?.proudText ?? "");
      setChangeText(reflection?.changeText ?? "");
      setPlanText(reflection?.planText ?? "");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [profile?.id, reflection?.changeText, reflection?.planText, reflection?.proudText]);

  useEffect(() => {
    const timer = window.setTimeout(() => setSelectedMonth(currentMonth), 0);
    return () => window.clearTimeout(timer);
  }, [profile?.id]);

  if (!state || !profile) return <MoneyStateGate error={stateError} onRetry={() => void revalidateMoneyState().catch(() => undefined)} />;

  function chooseProfile(id: string) {
    selectProfile(id);
    setSelectedMonth(currentMonth);
    setError("");
    setEditingId("");
    setTitle("");
    setTargetAmount("");
    setCompletedEditor(null);
  }

  async function postDream(payload: Record<string, unknown>, busyId: string): Promise<boolean> {
    setBusy(busyId);
    setError("");
    try {
      const response = await fetch("/api/dreams", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profileId: profile!.id, ...payload }),
      });
      const result = await response.json() as MoneyState & { error?: string };
      if (!response.ok) throw new Error(result.error || "儲存失敗");
      setMoneyStateCache(result);
      setNotice("剛剛已自動備份");
      if (["create", "update", "delete", "complete", "activate"].includes(String(payload.action))) { setTitle(""); setTargetAmount(""); setEditingId(""); }
      return true;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "儲存失敗";
      setError(message);
      if (payload.action === "update-completed") setCompletedEditError(message);
      return false;
    } finally {
      setBusy("");
    }
  }

  function createDream(event: FormEvent) {
    event.preventDefault();
    void postDream({ action: editingId ? "update" : "create", dreamId: editingId || undefined, title, kind, targetAmount: Number(targetAmount), parentPin: editingId ? parentPin : undefined }, "create");
  }

  async function unlockParent(event: FormEvent) {
    event.preventDefault();
    setBusy("pin");
    setPinError("");
    try {
      const response = await fetch("/api/parent-pin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: pinStatus === "setup" ? "setup" : "verify", pin: parentPin }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "家長操作碼驗證失敗");
      setPinStatus("unlocked");
      setNotice("家長夢想罐管理已解鎖");
    } catch (caught) {
      setPinError(caught instanceof Error ? caught.message : "驗證失敗");
    } finally {
      setBusy("");
    }
  }

  function startEdit(jar: DreamJar) {
    setEditingId(jar.id);
    setTitle(jar.title);
    setKind(jar.kind);
    setTargetAmount(String(jar.targetAmount));
    setError("");
  }

  function openCompletedEditor(jar: DreamJar) {
    setCompletedEditor(jar);
    setCompletedEditTitle(jar.title);
    setCompletedEditKind(jar.kind);
    setCompletedEditTarget(String(jar.targetAmount));
    setCompletedEditAmount(String(jar.completedAmount ?? jar.targetAmount));
    setCompletedEditStartedAt(toDateTimeLocal(jar.createdAt));
    setCompletedEditFinishedAt(toDateTimeLocal(jar.completedAt ?? jar.updatedAt));
    setCompletedEditError("");
  }

  async function saveCompletedDream(event: FormEvent) {
    event.preventDefault();
    if (!completedEditor) return;
    const startedAt = new Date(completedEditStartedAt);
    const finishedAt = new Date(completedEditFinishedAt);
    if (!completedEditStartedAt || !completedEditFinishedAt || Number.isNaN(startedAt.getTime()) || Number.isNaN(finishedAt.getTime())) {
      setCompletedEditError("請輸入完整的開始與完成日期時間");
      return;
    }
    if (finishedAt < startedAt) {
      setCompletedEditError("完成時間不能早於開始時間");
      return;
    }
    setCompletedEditError("");
    const ok = await postDream({
      action: "update-completed",
      dreamId: completedEditor.id,
      title: completedEditTitle,
      kind: completedEditKind,
      targetAmount: Number(completedEditTarget),
      completedAmount: Number(completedEditAmount),
      createdAt: startedAt.toISOString(),
      completedAt: finishedAt.toISOString(),
      parentPin,
    }, `completed-${completedEditor.id}`);
    if (ok) {
      setCompletedEditor(null);
      setNotice("已完成夢想的內容與日期時間已更新並備份");
    }
  }

  async function removeDream(jar: DreamJar) {
    if (!window.confirm(`確定刪除「${jar.title}」嗎？這不會刪除任何錢或交易紀錄。`)) return;
    await postDream({ action: "delete", dreamId: jar.id, parentPin }, `delete-${jar.id}`);
  }

  async function completeDream(jar: DreamJar) {
    if (!window.confirm(`把「${jar.title}」記錄為已完成嗎？完成金額會記為 ${money.format(jar.targetAmount)}，帳戶餘額不會因此改變。`)) return;
    await postDream({ action: "complete", dreamId: jar.id, completedAmount: jar.targetAmount, parentPin }, `complete-${jar.id}`);
  }

  async function activateDream(jar: DreamJar) {
    await postDream({ action: "activate", dreamId: jar.id, parentPin }, `activate-${jar.id}`);
  }

  async function saveReflection(event: FormEvent) {
    event.preventDefault();
    setBusy("reflection");
    setError("");
    try {
      const response = await fetch("/api/reflections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profileId: profile!.id, month: selectedMonth, proudText, changeText, planText }),
      });
      const result = await response.json() as MoneyState & { error?: string };
      if (!response.ok) throw new Error(result.error || "回顧儲存失敗");
      setMoneyStateCache(result);
      setNotice(`${formatMonth(selectedMonth)}回顧已存好；雲端副本會在背景完成`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "回顧儲存失敗");
    } finally {
      setBusy("");
    }
  }

  return (
    <main className="dream-shell" data-kid={profile.id} style={moneyThemeStyle(profile)}>
      <header className="parent-topbar">
        <Link className="brand" href="/"><span className="brand-mark" aria-hidden="true">¢</span><span><strong>小小理財島</strong><small>夢想與每月回顧</small></span></Link>
        <PrimaryNav active="dreams" />
      </header>

      <section className="dream-hero">
        <div><span className="parent-kicker">先問：這筆錢什麼時候要用？</span><h1>近一點的夢想留現金，<br /><em>很久以後的夢想讓投資陪它長大。</em></h1></div>
      </section>

      <section className={pinStatus === "unlocked" ? "parent-lock-card dream-admin-lock is-unlocked" : "parent-lock-card dream-admin-lock"}>
        <span className="lock-icon" aria-hidden="true">{pinStatus === "unlocked" ? "✓" : "🔒"}</span><div><b>{pinStatus === "unlocked" ? "家長夢想罐管理已解鎖" : pinStatus === "setup" ? "第一次使用：設定家長操作碼" : "家長可編輯或刪除夢想罐"}</b><small>夢想罐只是進度尺；編輯或刪除都不會改變撲滿、爸媽銀行或 ETF 的錢。</small></div>
        {pinStatus !== "unlocked" && pinStatus !== "loading" && <form onSubmit={unlockParent}><input type="password" inputMode="numeric" pattern="[0-9]{4,8}" minLength={4} maxLength={8} value={parentPin} onChange={(event) => setParentPin(event.target.value.replace(/\D/g, ""))} placeholder="4–8 位數字" required /><button disabled={busy === "pin"}>{busy === "pin" ? "驗證中…" : pinStatus === "setup" ? "設定並解鎖" : "解鎖"}</button></form>}
        {pinError && <p className="form-error">{pinError}</p>}
      </section>

      <section className="parent-profile-row dream-profiles">
        {state.profiles.map((item) => <button key={item.id} className={item.id === profile.id ? "parent-profile is-active" : "parent-profile"} onClick={() => chooseProfile(item.id)} style={{ "--profile-color": item.accent } as React.CSSProperties}><span><ProfileAvatar avatar={item.avatar} /></span><b>{item.name}</b><small>撲滿 {money.format(item.spendingBalance)}</small></button>)}
      </section>

      <section className="dream-layout">
        <div className="dream-main-column">
          <aside className="reflection-card">
            <div className="reflection-heading-row">
              <div><span className="parent-kicker">每月回顧</span><h2>這個月，錢教了我什麼？</h2></div>
              <div className="reflection-month-picker" aria-label="切換回顧月份">
                <button type="button" aria-label="較新的月份" disabled={selectedMonthIndex <= 0} onClick={() => setSelectedMonth(availableMonths[selectedMonthIndex - 1])}>‹</button>
                <select aria-label="選擇月份" value={selectedMonth} onChange={(event) => setSelectedMonth(event.target.value)}>{availableMonths.map((item) => <option key={item} value={item}>{formatMonth(item)}</option>)}</select>
                <button type="button" aria-label="較早的月份" disabled={selectedMonthIndex >= availableMonths.length - 1} onClick={() => setSelectedMonth(availableMonths[selectedMonthIndex + 1])}>›</button>
              </div>
            </div>
            <div className="month-numbers month-numbers-three">
              <span><small>這個月我存給未來</small><b>{monthActivities.length ? money.format(monthSaved) : "—"}</b><em>{monthVoluntarySaved > 0 ? `包含自主多存 ${money.format(monthVoluntarySaved)}` : "先存再花的累積"}</em></span>
              <span><small>這個月全部的錢變化 <InfoTip align="right">這是撲滿、爸媽銀行與 ETF 小森林合計的增減；ETF 漲跌也會影響，因此不等於這個月的收入或存款。</InfoTip></small><b className={monthAssetChange < 0 ? "is-negative" : ""}>{monthActivities.length ? signedMoney(monthAssetChange) : "—"}</b><em>月底和月初相比</em></span>
              <span><small>這個月我做了什麼選擇</small><b>{monthActivities.length ? money.format(monthSpend) : "—"}</b><em>{monthSpendCount ? `${monthSpendCount} 筆實際支出` : "沒有支出紀錄"}</em></span>
            </div>
            <form onSubmit={saveReflection}><label>我最滿意的一個選擇<textarea value={proudText} onChange={(event) => setProudText(event.target.value)} placeholder="我做了什麼好選擇？" maxLength={160} /></label><label>下次我想換個做法<textarea value={changeText} onChange={(event) => setChangeText(event.target.value)} placeholder="沒有對錯，只要說說看" maxLength={160} /></label><label>下個月想練習什麼？<textarea value={planText} onChange={(event) => setPlanText(event.target.value)} placeholder="例如：買東西前先等一天" maxLength={160} /></label>{error && <p className="form-error">{error}</p>}<button className="primary-button full-width" disabled={busy === "reflection"}>{busy === "reflection" ? "儲存中…" : reflection ? "更新這個月的回顧" : "存下這個月的回顧"}</button><small>{notice}</small></form>
          </aside>

          <div className="dream-heading"><div><span className="parent-kicker">{profile.name}的夢想</span><h2>現在想完成什麼？</h2></div><InfoTip align="right">短期進度跟著撲滿；長期進度跟著爸媽銀行與 ETF 小森林。夢想罐本身不另外存放或扣除金額。</InfoTip></div>
          <div className="dream-grid">
            {[{ kind: "short" as const, jar: activeShort }, { kind: "long" as const, jar: activeLong }].map(({ kind: slotKind, jar }) => {
              if (!jar) return <div className={`empty-dream kind-${slotKind}`} key={slotKind}><span>{slotKind === "short" ? "🐷" : "🌳"}</span><b>還沒有{slotKind === "short" ? "短期" : "長期"}夢想</b><small>{slotKind === "short" && queuedShort.length ? "可以從下方清單選一個開始。" : "可以從下方建立一個新目標。"}</small></div>;
              const current = jar.kind === "short" ? profile.spendingBalance : profile.bankBalance + profile.marketValue;
              const percent = Math.min(100, jar.targetAmount ? current / jar.targetAmount * 100 : 0);
              return <article className={`dream-card kind-${jar.kind}`} key={jar.id}>
                <div className="dream-card-top"><span>{jar.kind === "short" ? "短期 · 撲滿" : "長期 · 爸媽銀行＋ETF"}</span><b>{Math.round(percent)}%</b></div>
                <h3>{jar.title}</h3><p>{money.format(current)} / {money.format(jar.targetAmount)}</p>
                <div className="dream-progress"><i style={{ width: `${percent}%` }} /></div>
                <small className={jar.kind === "long" ? "long-note" : "dream-auto-note"}>{jar.kind === "short" ? "撲滿金額改變時，這裡會自動更新。" : `爸媽銀行 ${money.format(profile.bankBalance)} ＋ ETF ${money.format(profile.marketValue)}`}</small>
                {pinStatus === "unlocked" && <div className="dream-admin-actions"><button onClick={() => startEdit(jar)}>編輯</button><button className="complete-dream" disabled={busy === `complete-${jar.id}`} onClick={() => void completeDream(jar)}>{busy === `complete-${jar.id}` ? "記錄中…" : "完成夢想"}</button><button className="delete-dream" disabled={busy === `delete-${jar.id}`} onClick={() => void removeDream(jar)}>{busy === `delete-${jar.id}` ? "刪除中…" : "刪除"}</button></div>}
              </article>;
            })}
          </div>

          <details className="new-dream-card" open={!jars.length || Boolean(editingId)}>
            <summary>{editingId ? "✎ 家長編輯夢想罐" : "＋ 新增夢想"}</summary>
            <form onSubmit={createDream}><label>夢想名稱<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：一本想看的書" required maxLength={30} /></label><div className="form-two-columns"><label>多久以後使用？<select value={kind} disabled={Boolean(editingId)} onChange={(event) => setKind(event.target.value as "short" | "long")}><option value="short">短期：自動帶入撲滿</option><option value="long" disabled={!editingId && Boolean(activeLong)}>長期：自動帶入爸媽銀行＋ETF{activeLong && !editingId ? "（已有）" : ""}</option></select></label><label>目標金額<input type="number" min="50" max="10000000" value={targetAmount} onChange={(event) => setTargetAmount(event.target.value)} required /></label></div><div className="panel-help"><InfoTip>{kind === "short" ? activeShort && !editingId ? "目前已有短期夢想；這個新目標會先加入短期夢想清單。" : "短期夢想直接顯示撲滿的金額。" : "長期夢想顯示爸媽銀行加上 ETF 小森林的合計，不會另外扣款。"}</InfoTip></div><button className="primary-button" disabled={busy === "create" || (Boolean(editingId) && pinStatus !== "unlocked") || (!editingId && kind === "long" && Boolean(activeLong))}>{busy === "create" ? "儲存中…" : editingId ? "儲存家長修改" : kind === "short" && activeShort ? "加入短期夢想清單" : "建立目前夢想"}</button>{editingId && <button className="cancel-preset" type="button" onClick={() => { setEditingId(""); setTitle(""); setTargetAmount(""); }}>取消編輯</button>}</form>
          </details>

          <section className="dream-list-panel">
            <div className="dream-subheading"><div><span className="parent-kicker">下一個想完成的事</span><h2>短期夢想罐清單</h2></div><b>{queuedShort.length} 個</b></div>
            {queuedShort.length ? queuedShort.map((jar) => <article className="queued-dream-row" key={jar.id}><span>🐷</span><div><b>{jar.title}</b><small>目標 {money.format(jar.targetAmount)} · 加入於 {formatDate(jar.createdAt)}</small></div>{pinStatus === "unlocked" && <div><button disabled={Boolean(activeShort) || busy === `activate-${jar.id}`} onClick={() => void activateDream(jar)}>{busy === `activate-${jar.id}` ? "開始中…" : activeShort ? "先完成目前夢想" : "開始這個夢想"}</button><button onClick={() => startEdit(jar)}>編輯</button><button className="delete-dream" disabled={busy === `delete-${jar.id}`} onClick={() => void removeDream(jar)}>刪除</button></div>}</article>) : <p className="empty-list-note">清單還是空的；想到下一個小目標時再加進來。</p>}
          </section>

          <section className="completed-dream-panel">
            <div className="dream-subheading"><div><span className="parent-kicker">完成過的選擇</span><h2>已完成夢想罐</h2></div><b>{completedJars.length} 個</b></div>
            <div className="completed-dream-grid">{completedJars.map((jar) => <article key={jar.id}><span>{jar.kind === "short" ? "🐷" : "🌳"}</span><div><small>{jar.kind === "short" ? "短期夢想" : "長期夢想"}</small><h3>{jar.title}</h3><strong>{money.format(jar.completedAmount ?? jar.targetAmount)}</strong><p>開始 {formatDateTime(jar.createdAt)}<br />完成 {formatDateTime(jar.completedAt ?? jar.updatedAt)}<br />用了 {elapsedTime(jar.createdAt, jar.completedAt ?? jar.updatedAt)} · 原目標 {money.format(jar.targetAmount)}</p>{pinStatus === "unlocked" && <button className="edit-completed-dream" type="button" onClick={() => openCompletedEditor(jar)}>✎ 編輯紀錄</button>}</div></article>)}</div>
            {!completedJars.length && <p className="empty-list-note">第一個完成的夢想，會連同日期、花費時間與金額留在這裡。</p>}
          </section>
        </div>

      </section>

      {completedEditor && <div className="modal-backdrop" role="presentation" onMouseDown={() => busy !== `completed-${completedEditor.id}` && setCompletedEditor(null)}>
        <div className="modal completed-dream-editor" role="dialog" aria-modal="true" aria-labelledby="completed-dream-editor-title" onMouseDown={(event) => event.stopPropagation()}>
          <button className="modal-close" type="button" aria-label="關閉" onClick={() => setCompletedEditor(null)}>×</button>
          <span className="section-kicker">家長編輯</span>
          <h2 id="completed-dream-editor-title">已完成夢想罐</h2>
          <form onSubmit={saveCompletedDream}>
            <label className="input-label">夢想名稱<input className="text-input" value={completedEditTitle} onChange={(event) => setCompletedEditTitle(event.target.value)} minLength={2} maxLength={30} required /></label>
            <div className="form-two-columns">
              <label>夢想類型<select value={completedEditKind} onChange={(event) => setCompletedEditKind(event.target.value as "short" | "long")}><option value="short">短期夢想</option><option value="long">長期夢想</option></select></label>
              <label>原目標金額<input type="number" min="50" max="10000000" value={completedEditTarget} onChange={(event) => setCompletedEditTarget(event.target.value)} required /></label>
            </div>
            <label className="input-label">完成金額<input className="text-input" type="number" min="0" max="10000000" value={completedEditAmount} onChange={(event) => setCompletedEditAmount(event.target.value)} required /></label>
            <div className="form-two-columns completed-time-fields">
              <label>開始日期與時間<input type="datetime-local" value={completedEditStartedAt} onChange={(event) => setCompletedEditStartedAt(event.target.value)} required /></label>
              <label>完成日期與時間<input type="datetime-local" value={completedEditFinishedAt} onChange={(event) => setCompletedEditFinishedAt(event.target.value)} required /></label>
            </div>
            {completedEditStartedAt && completedEditFinishedAt && <p className="completed-duration-preview">完成歷時：{elapsedTime(completedEditStartedAt, completedEditFinishedAt)}</p>}
            {completedEditError && <p className="form-error">{completedEditError}</p>}
            <button className="primary-button full-width" disabled={busy === `completed-${completedEditor.id}`}>{busy === `completed-${completedEditor.id}` ? "儲存中…" : "儲存完成紀錄"}</button>
          </form>
        </div>
      </div>}
    </main>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "numeric", day: "numeric" }).format(new Date(value));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function toDateTimeLocal(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function formatMonth(value: string): string {
  const [year, monthValue] = value.split("-");
  return `${year} 年 ${Number(monthValue)} 月`;
}

function recentMonthKeys(count: number): string[] {
  const [year, monthValue] = currentMonth.split("-").map(Number);
  return Array.from({ length: count }, (_, index) => new Date(Date.UTC(year, monthValue - 1 - index, 1)).toISOString().slice(0, 7));
}

function signedMoney(value: number): string {
  if (value > 0) return `+${money.format(value)}`;
  return money.format(value);
}

function elapsedTime(startValue: string, endValue: string): string {
  const milliseconds = Math.max(0, new Date(endValue).getTime() - new Date(startValue).getTime());
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "不到 1 分鐘";
  if (minutes < 60) return `${minutes} 分鐘`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes ? `${hours} 小時 ${remainingMinutes} 分鐘` : `${hours} 小時`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  if (days < 30) return remainingHours ? `${days} 天 ${remainingHours} 小時` : `${days} 天`;
  const months = Math.floor(days / 30);
  const remainingDays = days % 30;
  return remainingDays ? `${months} 個月 ${remainingDays} 天` : `${months} 個月`;
}
