"use client";

import Link from "next/link";
import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { InfoTip } from "../info-tip";
import { MoneyStateGate, moneyThemeStyle, revalidateMoneyState, setMoneyStateCache, useMoneyStateCache, useSelectedProfile } from "../money-state-cache";
import type { MoneyActivity, MoneyState } from "../money-types";
import { PrimaryNav } from "../primary-nav";
import { ProfileAvatar } from "../profile-avatar";

const money = new Intl.NumberFormat("zh-TW", { style: "currency", currency: "TWD", maximumFractionDigits: 0 });

export default function HistoryPage() {
  const { state, error: stateError } = useMoneyStateCache();
  const { profile, chooseProfile: selectProfile } = useSelectedProfile(state?.profiles ?? []);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [pinStatus, setPinStatus] = useState<"loading" | "setup" | "locked" | "unlocked">("loading");
  const [parentPin, setParentPin] = useState("");
  const [editing, setEditing] = useState<MoneyActivity | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editNote, setEditNote] = useState("");
  const [editDate, setEditDate] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [activities, setActivities] = useState<MoneyActivity[]>([]);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [kinds, setKinds] = useState<string[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const historyRequestRef = useRef(0);
  const editModalRef = useRef<HTMLDivElement>(null);
  const editCloseRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    fetch("/api/parent-pin", { cache: "no-store" }).then(async (response) => {
      const result = await response.json().catch(() => null) as { configured?: boolean; error?: string } | null;
      if (response.status === 401) { window.location.replace("/family-access"); return; }
      if (!response.ok) throw new Error(result?.error || "無法讀取家長操作碼狀態");
      setPinStatus(result?.configured ? "locked" : "setup");
    }).catch(() => setPinStatus("locked"));
  }, []);

  useEffect(() => {
    if (editing) editCloseRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (!profile?.id) return;
    const timer = window.setTimeout(() => void loadActivities(0, false), query ? 250 : 0);
    return () => window.clearTimeout(timer);
    // loadActivities intentionally reads the latest query and kind values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id, query, kind]);

  if (!state || !profile) return <MoneyStateGate error={stateError} onRetry={() => void revalidateMoneyState().catch(() => undefined)} />;

  function chooseProfile(id: string) {
    selectProfile(id);
    closeEdit();
  }

  async function loadActivities(offset: number, append: boolean) {
    if (!profile?.id) return;
    const requestId = ++historyRequestRef.current;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const params = new URLSearchParams({
        profileId: profile.id,
        query,
        kind,
        offset: String(offset),
        limit: "40",
      });
      const response = await fetch(`/api/activities?${params}`, { cache: "no-store" });
      const result = await response.json().catch(() => null) as {
        activities?: MoneyActivity[];
        total?: number;
        nextOffset?: number | null;
        kinds?: string[];
        error?: string;
      } | null;
      if (response.status === 401) { window.location.replace("/family-access"); return; }
      if (!response.ok || !result?.activities) throw new Error(result?.error || "暫時無法讀取所有紀錄");
      if (requestId !== historyRequestRef.current) return;
      setActivities((current) => append ? [...current, ...result.activities!] : result.activities!);
      setTotal(Math.max(0, Number(result.total ?? result.activities.length)));
      setNextOffset(result.nextOffset ?? null);
      setKinds(result.kinds ?? []);
    } catch (caught) {
      if (requestId === historyRequestRef.current) {
        setHistoryError(caught instanceof Error ? caught.message : "暫時無法讀取所有紀錄");
      }
    } finally {
      if (requestId === historyRequestRef.current) setHistoryLoading(false);
    }
  }

  function startEdit(item: MoneyActivity) {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditing(item);
    setEditLabel(item.label);
    setEditNote(item.note);
    setEditDate(item.entryDate);
    setError("");
  }

  function closeEdit() {
    const focusTarget = editing ? previousFocusRef.current : null;
    setEditing(null);
    previousFocusRef.current = null;
    if (focusTarget) window.requestAnimationFrame(() => focusTarget.focus());
  }

  function handleEditDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeEdit();
      return;
    }
    if (event.key !== "Tab" || !editModalRef.current) return;
    const focusable = Array.from(editModalRef.current.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], summary, [tabindex]:not([tabindex='-1'])",
    ));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function unlock(event: FormEvent) {
    event.preventDefault();
    setBusy("pin");
    setError("");
    try {
      const response = await fetch("/api/parent-pin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: pinStatus === "setup" ? "setup" : "verify", pin: parentPin }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "操作碼驗證失敗");
      setPinStatus("unlocked");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "操作碼驗證失敗"); }
    finally { setBusy(""); }
  }

  async function activityRequest(payload: Record<string, unknown>, busyId: string) {
    setBusy(busyId);
    setError("");
    try {
      const response = await fetch("/api/activities", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, parentPin }) });
      const result = await response.json() as MoneyState & { error?: string };
      if (!response.ok) throw new Error(result.error || "紀錄調整失敗");
      setMoneyStateCache(result);
      closeEdit();
      await loadActivities(0, false);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "紀錄調整失敗"); }
    finally { setBusy(""); }
  }

  function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    void activityRequest({ action: "edit", activityId: editing.id, label: editLabel, note: editNote, entryDate: editDate }, editing.id);
  }

  function remove(item: MoneyActivity) {
    if (!window.confirm(`確定要刪除「${item.label}」嗎？系統會撤銷這筆紀錄造成的餘額變化。`)) return;
    void activityRequest({ action: "delete", activityId: item.id }, `delete-${item.id}`);
  }

  return <main className="history-shell" data-kid={profile.id} style={moneyThemeStyle(profile)}>
    <header className="parent-topbar"><Link className="brand" href="/"><span className="brand-mark">¢</span><span><strong>小小理財島</strong><small>完整紀錄</small></span></Link><PrimaryNav active="history" /></header>
    <section className="history-hero"><div><span className="parent-kicker">所有紀錄都在這裡</span><h1><span className="heading-avatar"><ProfileAvatar avatar={profile.avatar} /></span>{profile.name}的錢，<br /><em>每一步都有故事。</em></h1></div></section>
    <section className="parent-profile-row history-profiles">{state.profiles.map((item) => <button key={item.id} aria-pressed={item.id === profile.id} className={item.id === profile.id ? "parent-profile is-active" : "parent-profile"} onClick={() => chooseProfile(item.id)} style={{ "--profile-color": item.accent } as React.CSSProperties}><span><ProfileAvatar avatar={item.avatar} /></span><b>{item.name}</b><small>{item.id === profile.id ? `${total} 筆紀錄` : "選擇查看"}</small></button>)}</section>
    <section className="history-layout">
      <aside className="history-controls">
        <h2>篩選紀錄</h2>
        <label>搜尋<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="名稱、備註或日期" /></label>
        <label>紀錄類型<select value={kind} onChange={(event) => setKind(event.target.value)}><option value="all">全部類型</option>{kinds.map((item) => <option key={item} value={item}>{kindName(item)}</option>)}</select></label>
        <div className={pinStatus === "unlocked" ? "history-lock is-unlocked" : "history-lock"}>
          <div className="history-lock-heading"><span aria-hidden="true">{pinStatus === "unlocked" ? "✓" : "🔒"}</span><b>{pinStatus === "unlocked" ? "家長編輯已解鎖" : pinStatus === "setup" ? "第一次設定家長碼" : "家長編輯已上鎖"}</b></div>
          {pinStatus !== "unlocked" && pinStatus !== "loading" && <form onSubmit={unlock}><label className="sr-only" htmlFor="history-parent-pin">家長操作碼</label><input id="history-parent-pin" aria-describedby="history-pin-help" type="password" inputMode="numeric" pattern="[0-9]{4,8}" value={parentPin} onChange={(event) => setParentPin(event.target.value.replace(/\D/g, ""))} placeholder="4–8 位數字" required /><span className="sr-only" id="history-pin-help">輸入四到八位數字，解鎖編輯與可撤銷紀錄的刪除功能。</span><button disabled={busy === "pin"}>{busy === "pin" ? "驗證中…" : "解鎖"}</button></form>}
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
      </aside>
      <section className="history-list"><div className="history-heading"><div><span className="parent-kicker">符合條件</span><h2>{total} 筆紀錄</h2></div><InfoTip label="編輯與刪除說明">先解鎖家長編輯即可修改說明。只有能安全撤銷餘額變化的紀錄可在這裡刪除；持股、專案與匯入資料請到對應家長功能調整。</InfoTip></div>{historyError && <p className="form-error" role="alert">{historyError}</p>}{activities.map((item) => { const deletable = (item.source === "app" && ["allowance", "spend", "reward", "dream", "savings-transfer"].includes(item.kind)) || (item.source === "parent" && item.kind === "piggy-adjustment"); const deleteHelp = pinStatus !== "unlocked" ? "請先解鎖家長編輯" : deletable ? "刪除並撤銷餘額變化" : "請到對應家長功能調整"; return <article className="history-row" key={item.id}><span className={`timeline-dot kind-${item.kind}`}>{historyIcon(item.kind)}</span><div><b>{item.label}</b><small>{item.entryDate} · {kindName(item.kind)} · {item.note || "沒有備註"}</small><i>{deltaText(item)}</i></div><strong>{item.amount ? money.format(item.amount) : "—"}</strong><div className="history-actions"><button disabled={pinStatus !== "unlocked"} title={pinStatus === "unlocked" ? "編輯紀錄說明" : "請先解鎖家長編輯"} onClick={() => startEdit(item)}>編輯</button><button className="delete-record" disabled={pinStatus !== "unlocked" || !deletable || busy === `delete-${item.id}`} title={deleteHelp} aria-label={`刪除「${item.label}」：${deleteHelp}`} onClick={() => remove(item)}>{busy === `delete-${item.id}` ? "刪除中…" : "刪除"}</button></div></article>; })}{!historyLoading && !activities.length && <p className="empty-history">沒有符合條件的紀錄。</p>}{historyLoading && !activities.length && <p className="empty-history" role="status">正在讀取紀錄…</p>}{nextOffset !== null && <button className="load-more-button" type="button" disabled={historyLoading} onClick={() => void loadActivities(nextOffset, true)}>{historyLoading ? "讀取中…" : `載入更多（已顯示 ${activities.length}／${total}）`}</button>}</section>
    </section>
    {editing && <div className="modal-backdrop" onMouseDown={closeEdit}><div ref={editModalRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="history-edit-title" aria-describedby="history-edit-help" tabIndex={-1} onKeyDown={handleEditDialogKeyDown} onMouseDown={(event) => event.stopPropagation()}><button ref={editCloseRef} className="modal-close" aria-label="關閉編輯紀錄視窗" onClick={closeEdit}>×</button><div className="heading-help"><span className="parent-kicker">家長編輯紀錄</span><InfoTip>金額與分配不在這裡修改，避免帳務失去平衡。</InfoTip></div><h2 id="history-edit-title">{editing.label}</h2><p className="sr-only" id="history-edit-help">可以修改紀錄名稱、日期與備註；不能修改金額與分配。</p><form onSubmit={saveEdit}><label className="input-label" htmlFor="history-edit-label">紀錄名稱</label><input id="history-edit-label" className="text-input" value={editLabel} onChange={(event) => setEditLabel(event.target.value)} maxLength={60} required /><label className="input-label" htmlFor="history-edit-date">日期</label><input id="history-edit-date" className="text-input" type="date" value={editDate} onChange={(event) => setEditDate(event.target.value)} required /><label className="input-label" htmlFor="history-edit-note">備註</label><textarea id="history-edit-note" className="text-input" value={editNote} onChange={(event) => setEditNote(event.target.value)} maxLength={160} />{error && <p className="form-error" role="alert">{error}</p>}<button className="primary-button full-width" disabled={busy === editing.id}>{busy === editing.id ? "儲存中…" : "儲存修改"}</button></form></div></div>}
  </main>;
}

function kindName(kind: string): string {
  const names: Record<string, string> = { allowance: "零用錢", spend: "花費", reward: "爸媽獎勵", project: "家庭小專案", dream: "夢想罐", "savings-transfer": "自主存錢", "piggy-adjustment": "撲滿校正", "stock-buy": "股票買入", etf: "投資", harvest: "過年收成", "market-update": "市值更新", "sheet-deposit": "試算表存款", welcome: "開始" };
  return names[kind] ?? kind;
}
function historyIcon(kind: string): string { if (kind === "spend") return "−"; if (kind === "reward") return "★"; if (kind === "savings-transfer") return "🌱"; if (["stock-buy", "etf", "market-update"].includes(kind)) return "↗"; if (kind === "harvest") return "福"; if (kind === "dream") return "☁"; return "+"; }
function deltaText(item: MoneyActivity): string { const parts = []; if (item.spendDelta) parts.push(`撲滿 ${item.spendDelta > 0 ? "+" : ""}${item.spendDelta}`); if (item.bankDelta) parts.push(`爸媽銀行 ${item.bankDelta > 0 ? "+" : ""}${item.bankDelta}`); if (item.marketDelta) parts.push(`ETF 小森林 ${item.marketDelta > 0 ? "+" : ""}${item.marketDelta}`); return parts.join(" · ") || "沒有改變餘額"; }
