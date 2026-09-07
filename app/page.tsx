"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { MoneyStateGate, moneyThemeStyle, revalidateMoneyState, setMoneyStateCache, useMoneyStateCache, useSelectedProfile } from "./money-state-cache";
import type { GardenSpecies, KidProfile, MoneyActivity, MoneyState, TransactionKind } from "./money-types";
import { PrimaryNav } from "./primary-nav";
import { ProfileAvatar } from "./profile-avatar";
import { StatusToast, useStatusToast } from "./status-toast";

const money = new Intl.NumberFormat("zh-TW", {
  style: "currency",
  currency: "TWD",
  maximumFractionDigits: 0,
});

function totalAssets(profile: KidProfile): number {
  return profile.spendingBalance + profile.bankBalance + profile.marketValue;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-TW", {
    month: "short",
    day: "numeric",
    timeZone: "Asia/Taipei",
  }).format(new Date(`${value.slice(0, 10)}T12:00:00+08:00`));
}

function relativeBackup(value?: string): string {
  if (!value) return "等待第一次備份";
  const diff = Date.now() - new Date(value).getTime();
  if (diff < 60_000) return "剛剛已備份";
  return `${new Intl.DateTimeFormat("zh-TW", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Taipei",
  }).format(new Date(value))} 已備份`;
}

function savedStatus(state: MoneyState, message: string): { message: string; tone: "success" | "waiting" } {
  if (state.backupHealth?.status === "failed") {
    return { message: `${message}；雲端備份稍後重試`, tone: "waiting" };
  }
  if (state.backupHealth?.status === "pending") {
    return { message: `${message}；雲端副本會在背景完成`, tone: "success" };
  }
  return { message, tone: "success" };
}

const gardenOptions: Array<{ value: GardenSpecies; emoji: string; label: string }> = [
  { value: "tree", emoji: "🌳", label: "綠葉樹" },
  { value: "cherry", emoji: "🌸", label: "櫻花樹" },
  { value: "pine", emoji: "🌲", label: "松樹" },
  { value: "sunflower", emoji: "🌻", label: "向日葵" },
  { value: "tulip", emoji: "🌷", label: "鬱金香" },
  { value: "daisy", emoji: "🌼", label: "小雛菊" },
];

function gardenOption(value?: GardenSpecies) {
  return gardenOptions.find((item) => item.value === value) ?? gardenOptions[0];
}

type AssetPoint = { month: string; label: string; value: number };

function assetTimeline(profile: KidProfile, activities: MoneyActivity[]): AssetPoint[] {
  const monthly = new Map<string, number>();
  let running = 0;
  const sorted = activities
    .filter((item) => item.profileId === profile.id)
    .sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.createdAt.localeCompare(b.createdAt));

  for (const item of sorted) {
    running = Math.max(0, running + item.spendDelta + item.bankDelta + item.marketDelta);
    monthly.set(item.entryDate.slice(0, 7), running);
  }

  const currentMonth = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
  }).format(new Date()).slice(0, 7);
  monthly.set(currentMonth, totalAssets(profile));

  const all = Array.from(monthly, ([month, value]) => ({
    month,
    label: `${Number(month.slice(5, 7))}月`,
    value,
  })).sort((a, b) => a.month.localeCompare(b.month));
  if (all.length <= 10) return all;
  const sampled = Array.from({ length: 10 }, (_, index) => all[Math.round(index * (all.length - 1) / 9)]);
  return sampled.filter((item, index) => index === 0 || item.month !== sampled[index - 1].month);
}

export default function Home() {
  const { state, error: stateError, revalidating } = useMoneyStateCache();
  const { profile, chooseProfile } = useSelectedProfile(state?.profiles ?? []);
  const [action, setAction] = useState<TransactionKind | null>(null);
  const [amount, setAmount] = useState("");
  const [label, setLabel] = useState("");
  const [transactionOperationId, setTransactionOperationId] = useState(() => crypto.randomUUID());
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [projectBusy, setProjectBusy] = useState("");
  const [projectError, setProjectError] = useState("");
  const [gardenBusy, setGardenBusy] = useState(false);
  const [saveMoreOpen, setSaveMoreOpen] = useState(false);
  const [saveMoreAmount, setSaveMoreAmount] = useState("");
  const [saveMoreNote, setSaveMoreNote] = useState("");
  const [saveMoreBusy, setSaveMoreBusy] = useState(false);
  const [saveMoreError, setSaveMoreError] = useState("");
  const [savingsOperationId, setSavingsOperationId] = useState(() => crypto.randomUUID());
  const { toast, showStatus, dismissStatus } = useStatusToast();

  useEffect(() => {
    if (stateError) showStatus("同步失敗，畫面先保留上次的資料", "error");
  }, [showStatus, stateError]);

  const activities = useMemo(
    () => state && profile ? state.activities.filter((item) => item.profileId === profile.id).slice(0, 6) : [],
    [profile, state],
  );
  const profileHoldings = state && profile ? state.holdings.filter((item) => item.profileId === profile.id) : [];
  const assetPoints = useMemo(
    () => state && profile ? assetTimeline(profile, state.activities) : [],
    [profile, state],
  );
  if (!state || !profile) {
    return <MoneyStateGate error={stateError} onRetry={() => void revalidateMoneyState().catch(() => undefined)} />;
  }

  const activeDreams = state.dreamJars
    .filter((item) => item.profileId === profile.id && item.status === "active")
    .slice(0, 2);
  const pendingSavings = state.savingsTransfers.filter((item) => item.profileId === profile.id && item.status === "pending");
  const pendingSavingsAmount = pendingSavings.reduce((sum, item) => sum + item.amount, 0);
  const savingAvailable = Math.max(0, profile.spendingBalance - pendingSavingsAmount);
  const saveMoreValue = Math.max(0, Math.round(Number(saveMoreAmount) || 0));
  const saveMorePreview = Math.min(saveMoreValue, savingAvailable);
  const allowance = Math.max(0, Math.round(Number(amount) || 0));
  const savingsRate = Math.min(100, Math.max(0, state.savingsRate ?? 30));
  const spendingRate = 100 - savingsRate;
  const investPreview = allowance ? Math.round(allowance * savingsRate / 100) : 0;
  const spendPreview = allowance - investPreview;
  const returnRate = profile.stockCost > 0
    ? ((profile.marketValue - profile.stockCost) / profile.stockCost) * 100
    : 0;

  function openAction(kind: TransactionKind) {
    setAction(kind);
    setAmount("");
    setLabel("");
    setError("");
    setTransactionOperationId(crypto.randomUUID());
  }

  function addAllowanceAmount(increment: number) {
    setAmount(String(Math.min(100000, allowance + increment)));
  }

  function addSaveMoreAmount(increment: number) {
    setSaveMoreAmount(String(Math.min(savingAvailable, saveMoreValue + increment)));
  }

  function announce(message: string, tone: "success" | "waiting" = "success") {
    setNotice(message);
    showStatus(message, tone);
  }

  function reportError(message: string, updateLocal: (next: string) => void) {
    updateLocal(message);
    showStatus(message, "error");
  }

  async function postTransaction(kind: TransactionKind, customAmount?: number) {
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/transactions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profileId: profile!.id,
          kind,
          amount: customAmount ?? Number(amount),
          label,
          operationId: transactionOperationId,
        }),
      });
      const result = await response.json() as MoneyState & { error?: string };
      if (!response.ok) throw new Error(result.error || "儲存失敗");
      setMoneyStateCache(result);
      const saved = savedStatus(result, kind === "allowance" ? "零用錢已經記在帳本裡" : "花費已經記在帳本裡");
      announce(saved.message, saved.tone);
      setAction(null);
    } catch (caught) {
      reportError(caught instanceof Error ? caught.message : "儲存失敗", setError);
    } finally {
      setSaving(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!action) return;
    void postTransaction(action);
  }

  async function postProject(projectAction: "claim" | "submit", projectId: string) {
    setProjectBusy(projectId);
    setProjectError("");
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: projectAction,
          projectId,
          profileId: profile!.id,
        }),
      });
      const result = await response.json() as MoneyState & { error?: string };
      if (!response.ok) throw new Error(result.error || "儲存失敗");
      setMoneyStateCache(result);
      announce(
        projectAction === "submit" ? "已經送給爸媽確認" : "已經接下這個家庭小專案",
        projectAction === "submit" ? "waiting" : "success",
      );
    } catch (caught) {
      reportError(caught instanceof Error ? caught.message : "儲存失敗", setProjectError);
    } finally {
      setProjectBusy("");
    }
  }

  async function chooseGarden(next: GardenSpecies) {
    setGardenBusy(true);
    setError("");
    try {
      const response = await fetch("/api/garden", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profileId: profile!.id, gardenSpecies: next }),
      });
      const result = await response.json() as MoneyState & { error?: string };
      if (!response.ok) throw new Error(result.error || "花園設定失敗");
      setMoneyStateCache(result);
      showStatus("小森林的植物已經換好了", "success");
    } catch (caught) {
      reportError(caught instanceof Error ? caught.message : "花園設定失敗", setError);
    } finally {
      setGardenBusy(false);
    }
  }

  function openSaveMore() {
    setSaveMoreAmount("");
    setSaveMoreNote("");
    setSaveMoreError("");
    setSavingsOperationId(crypto.randomUUID());
    setSaveMoreOpen(true);
  }

  async function requestSavingsTransfer(event: FormEvent) {
    event.preventDefault();
    setSaveMoreBusy(true);
    setSaveMoreError("");
    try {
      const response = await fetch("/api/savings-transfers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "request", profileId: profile!.id, amount: saveMoreValue, note: saveMoreNote, operationId: savingsOperationId }),
      });
      const result = await response.json() as MoneyState & { error?: string };
      if (!response.ok) throw new Error(result.error || "自主存錢申請失敗");
      setMoneyStateCache(result);
      announce("自主多存已送給爸媽確認", "waiting");
      setSaveMoreOpen(false);
    } catch (caught) {
      reportError(caught instanceof Error ? caught.message : "自主存錢申請失敗", setSaveMoreError);
    } finally {
      setSaveMoreBusy(false);
    }
  }

  return (
    <main
      className="site-shell"
      data-kid={profile.id}
      style={moneyThemeStyle(profile)}
    >
      <header className="topbar">
        <a className="brand" href="#top" aria-label="回到小小理財島首頁">
          <span className="brand-mark" aria-hidden="true">¢</span>
          <span>
            <strong>小小理財島</strong>
            <small>先存一點，夢想長大</small>
          </span>
        </a>
        <div className="top-profile-picker" aria-label="切換小朋友">
          <span className="profile-label">今天是誰？</span>
          <div className="profile-switcher">
            {state.profiles.map((item) => (
              <button
                key={item.id}
                className={item.id === profile.id ? "profile-chip is-active" : "profile-chip"}
                onClick={() => chooseProfile(item.id)}
                aria-pressed={item.id === profile.id}
                aria-label={`切換到${item.name}`}
                style={{ "--profile-color": item.accent } as React.CSSProperties}
              >
                <span><ProfileAvatar avatar={item.avatar} /></span><b>{item.name}</b>
              </button>
            ))}
          </div>
        </div>
        <div className="top-actions">
          <span className="backup-status"><i aria-hidden="true" />{stateError ? "同步失敗，畫面保留上次資料" : revalidating ? "正在同步最新帳本…" : notice || relativeBackup(state.latestBackup?.createdAt)}</span>
          <PrimaryNav active="home" />
        </div>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <span className="eyebrow">{profile.name}的理財小基地</span>
          <h1>{profile.name}的錢，<br /><em>正在慢慢長大。</em></h1>
          <div className="hero-practice" aria-label={`零用錢分成 ${savingsRate}% 留給未來與 ${spendingRate}% 自己決定`}>
            <div><b>{savingsRate}%</b><small>先留給未來</small></div>
            <div><b>{spendingRate}%</b><small>自己做選擇</small></div>
          </div>
          <div className="hero-actions">
            <button className="primary-button" onClick={() => openAction("allowance")}>
              <span aria-hidden="true">＋</span> 記一筆零用錢
            </button>
            <button className="secondary-button" onClick={() => openAction("spend")}>
              記一筆花費
            </button>
          </div>
        </div>
        <IslandGarden
          avatar={profile.avatar}
          name={profile.name}
          value={profile.marketValue}
          futureValue={profile.bankBalance + profile.marketValue}
          futurePrincipal={profile.futurePrincipal ?? 0}
          species={profile.gardenSpecies ?? "tree"}
          busy={gardenBusy}
          onChange={(next) => void chooseGarden(next)}
        />
      </section>

      <section className="wallet-grid" aria-label="錢包總覽">
        <MoneyCard
          icon="🐷"
          tone="yellow"
          title="可以自己決定（撲滿）"
          value={profile.spendingBalance}
          caption={profile.spendingBalance ? "用來買想要的東西" : "從下一筆零用錢開始記錄"}
        />
        <MoneyCard
          icon="🏦"
          tone="pink"
          title="爸媽銀行"
          value={profile.bankBalance}
          caption={profile.bankBalance >= 1000
            ? "有存錢獎勵；已經可以請爸媽協助種進小森林"
            : `有存錢獎勵；再存 ${money.format(1000 - profile.bankBalance)} 就能請爸媽協助種樹`}
          pending={pendingSavingsAmount ? `${money.format(pendingSavingsAmount)} 等待爸媽確認` : undefined}
          actionLabel="🌱 我想多存一點"
          onAction={openSaveMore}
        />
        <MoneyCard
          icon="🌳"
          tone="green"
          title="ETF 小森林"
          value={profile.marketValue}
          caption={profileHoldings.length === 1
            ? `${profileHoldings[0].symbol} · ${profileHoldings[0].units} 股 · ${returnRate >= 0 ? "+" : ""}${returnRate.toFixed(1)}%`
            : profileHoldings.length > 1
              ? `${profileHoldings.length} 個標的 · ${returnRate >= 0 ? "+" : ""}${returnRate.toFixed(1)}%`
              : "長期投資，會漲也會跌"}
        />
      </section>

      <section className="content-grid">
        <AssetGrowthChart points={assetPoints} current={totalAssets(profile)} profile={profile} dreams={activeDreams} />

        <article className="activity-card">
          <div className="section-heading">
            <div>
              <span className="section-kicker">最近紀錄</span>
              <h2>錢的成長足跡</h2>
            </div>
            <Link className="record-count" href="/history">查看全部 →</Link>
          </div>
          <div className="timeline">
            {activities.map((item) => (
              <div className="timeline-item" key={item.id}>
                <span className={`timeline-dot kind-${item.kind}`} aria-hidden="true">
                  {activityIcon(item.kind)}
                </span>
                <div>
                  <strong>{item.label}</strong>
                  <small>{formatDate(item.entryDate)} · {item.note}</small>
                </div>
                <b>{item.amount ? money.format(item.amount) : "開始"}</b>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="projects-section" aria-labelledby="projects-title">
        <div className="projects-heading">
          <div>
            <span className="section-kicker">偶爾才開放</span>
            <h2 id="projects-title">家庭小專案</h2>
            <p>只有家長事前約定、超出日常責任的完整任務才會出現在這裡。</p>
          </div>
          <span className="project-principle"><b>完成後才發放</b>報酬一樣先存 {savingsRate}%</span>
        </div>
        <div className="project-grid">
          {state.projects.map((item) => {
            const assigned = state.profiles.find((kid) => kid.id === item.assignedProfileId);
            const isMine = item.assignedProfileId === profile.id;
            return (
              <article className={`project-card status-${item.status}`} key={item.id}>
                <div className="project-card-top">
                  <span className="project-status">{projectStatus(item.status, assigned?.name)}</span>
                  <strong>{money.format(item.reward)}</strong>
                </div>
                <h3>{item.title}</h3>
                <p>{item.description}</p>
                {item.status === "open" && (
                  <button disabled={projectBusy === item.id} onClick={() => void postProject("claim", item.id)}>
                    {projectBusy === item.id ? "正在登記…" : `${profile.name}想接這個專案`}
                  </button>
                )}
                {item.status === "claimed" && isMine && (
                  <button disabled={projectBusy === item.id} onClick={() => void postProject("submit", item.id)}>
                    {projectBusy === item.id ? "正在送出…" : "我完成了，請家長確認"}
                  </button>
                )}
                {item.status === "claimed" && !isMine && <small>{assigned?.name}正在進行中</small>}
                {item.status === "waiting" && <small className="waiting-note">⌛ 等待家長在家長專區確認</small>}
                {item.status === "completed" && <small className="completed-note">✓ 已完成並分配報酬</small>}
              </article>
            );
          })}
        </div>
        {projectError && <p className="form-error project-error">{projectError}</p>}
      </section>

      <section className="rules-section" id="rules">
        <div className="rules-copy">
          <span className="section-kicker">我們家的約定</span>
          <h2>錢是用來練習選擇，<br />不是拿來考試。</h2>
          <p>記不清楚時，我們一起補帳；花錯一次，也能變成下次更好的選擇。</p>
        </div>
        <div className="rule-list">
          <Rule number="01" title="先存再花" text={`每次收到零用錢，先留下 ${savingsRate}% 給未來。`} />
          <Rule number="02" title="想要自己買" text="飲料、小玩具和非必要文具，用自己的零用錢選擇。" />
          <Rule number="03" title="需要由爸媽負責" text="餐點、衣服、學校用品、書籍與教育需要，由爸媽準備。" />
          <Rule number="04" title="一起記、一起想" text="漏記就一起回想，不會因為忘記記帳而取消零用錢。" />
        </div>
      </section>

      <footer>
        <strong>小小理財島 · 讓好習慣慢慢長大</strong>
        <span className="footer-credit">著作注記 · <a href="https://www.facebook.com/profile.php?id=100084000897269" target="_blank" rel="noreferrer">fb/指數三寶飯</a></span>
      </footer>

      {action && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => !saving && setAction(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="money-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" onClick={() => setAction(null)} aria-label="關閉">×</button>
            <span className="modal-avatar"><ProfileAvatar avatar={profile.avatar} name={profile.name} /></span>
            <p className="section-kicker">{profile.name}的紀錄</p>
            <h2 id="money-dialog-title">{action === "allowance" ? "收到多少零用錢？" : "這次花了多少錢？"}</h2>
            <form onSubmit={submit}>
              {action === "allowance" && <div className="quick-amounts quick-amounts-three" aria-label="快速增加零用錢金額">
                {[10, 100, 1000].map((value) => <button key={value} type="button" disabled={allowance >= 100000} onClick={() => addAllowanceAmount(value)}>＋{value.toLocaleString("zh-TW")}</button>)}
              </div>}
              <label className="input-label" htmlFor="money-amount">金額</label>
              <div className="money-input"><span>NT$</span><input id="money-amount" inputMode="numeric" min="1" max="100000" type="number" value={amount} onChange={(event) => setAmount(event.target.value)} autoFocus required /></div>
              <label className="input-label" htmlFor="money-label">{action === "allowance" ? "這筆錢從哪裡來？" : "買了什麼？"}</label>
              <input className="text-input" id="money-label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder={action === "allowance" ? "例如：本週零用錢" : "例如：貼紙"} />
              {action === "allowance" && (
                <div className="preview-split">
                  <span><b>{money.format(investPreview)}</b>先存 {savingsRate}%</span>
                  <span><b>{money.format(spendPreview)}</b>自己安排 {spendingRate}%</span>
                </div>
              )}
              {error && <p className="form-error">{error}</p>}
              <button className="primary-button full-width" disabled={saving || allowance <= 0}>
                {saving ? "正在存進雲端…" : "存好這一筆"}
              </button>
              <small className="auto-save-note">儲存後會自動留下雲端備份</small>
            </form>
          </div>
        </div>
      )}

      {saveMoreOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => !saveMoreBusy && setSaveMoreOpen(false)}>
          <div className="modal savings-transfer-modal" role="dialog" aria-modal="true" aria-labelledby="save-more-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" onClick={() => setSaveMoreOpen(false)} aria-label="關閉">×</button>
            <span className="modal-avatar"><ProfileAvatar avatar={profile.avatar} name={profile.name} /></span>
            <p className="section-kicker">把現在的一點自由留給未來</p>
            <h2 id="save-more-dialog-title">想多存多少到爸媽銀行？</h2>
            <p className="transfer-dialog-copy">送出後先等待爸媽確認；確認完成才會真的從撲滿搬到爸媽銀行。</p>
            {savingAvailable <= 0 && (
              <p className="no-transfer-balance" role="status">
                {pendingSavingsAmount > 0
                  ? "撲滿裡的錢目前都在等待爸媽確認；處理完成後再來看看。"
                  : "撲滿目前沒有可以移動的錢；下次收到零用錢後，就可以自主多存。"}
              </p>
            )}
            <form onSubmit={requestSavingsTransfer}>
              <div className="quick-amounts" aria-label="快速選擇金額">
                {[10, 100, 1000].map((value) => <button key={value} type="button" disabled={savingAvailable <= 0 || saveMoreValue >= savingAvailable} onClick={() => addSaveMoreAmount(value)}>＋{value.toLocaleString("zh-TW")}</button>)}
                <button type="button" disabled={savingAvailable <= 0} onClick={() => setSaveMoreAmount(String(savingAvailable))}>全部</button>
              </div>
              <label className="input-label" htmlFor="save-more-amount">自主存入金額</label>
              <div className="money-input"><span>NT$</span><input id="save-more-amount" inputMode="numeric" min="1" max={savingAvailable} type="number" value={saveMoreAmount} onChange={(event) => setSaveMoreAmount(event.target.value)} autoFocus disabled={savingAvailable <= 0} required /></div>
              <label className="input-label" htmlFor="save-more-note">想留給未來做什麼？（選填）</label>
              <input className="text-input" id="save-more-note" value={saveMoreNote} onChange={(event) => setSaveMoreNote(event.target.value)} placeholder="例如：想讓長期夢想快一點長大" maxLength={80} />
              <div className="transfer-preview">
                <span><small>撲滿</small><b>{money.format(profile.spendingBalance)} → {money.format(profile.spendingBalance - saveMorePreview)}</b></span>
                <i aria-hidden="true">→</i>
                <span><small>爸媽銀行</small><b>{money.format(profile.bankBalance)} → {money.format(profile.bankBalance + saveMorePreview)}</b></span>
              </div>
              {pendingSavingsAmount > 0 && <small className="pending-transfer-note">另有 {money.format(pendingSavingsAmount)} 正在等待爸媽確認</small>}
              {saveMoreError && <p className="form-error">{saveMoreError}</p>}
              <button className="primary-button full-width" disabled={saveMoreBusy || saveMoreValue <= 0 || saveMoreValue > savingAvailable}>{saveMoreBusy ? "正在送出…" : "請爸媽確認"}</button>
            </form>
          </div>
        </div>
      )}

      <StatusToast toast={toast} onDismiss={dismissStatus} />

    </main>
  );
}

function MoneyCard({ icon, tone, title, value, caption, pending, actionLabel, onAction }: { icon: string; tone: string; title: string; value: number; caption: string; pending?: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <article className={`money-card ${tone}`}>
      <span className="money-card-icon" aria-hidden="true">{icon}</span>
      <div>
        <small>{title}</small>
        <div className="money-card-value-row">
          <strong>{money.format(value)}</strong>
          {actionLabel && onAction && <button className="money-card-action" type="button" onClick={onAction}>{actionLabel}</button>}
        </div>
        <p>{caption}</p>
        {pending && <span className="money-card-pending">⌛ {pending}</span>}
      </div>
    </article>
  );
}

function IslandGarden({
  avatar,
  name,
  value,
  futureValue,
  futurePrincipal,
  species,
  busy,
  onChange,
}: {
  avatar: string;
  name: string;
  value: number;
  futureValue: number;
  futurePrincipal: number;
  species: GardenSpecies;
  busy: boolean;
  onChange: (next: GardenSpecies) => void;
}) {
  const selected = gardenOption(species);
  const fullPlants = Math.floor(value / 1000);
  const remainder = value % 1000;
  const visualCount = value > 0 ? Math.min(12, Math.max(1, fullPlants + (remainder ? 1 : 0))) : 0;
  const forestMaturity = 1 + Math.min(.28, Math.floor(fullPlants / 12) * .07);
  const forestLayout = [
    { x: 50, bottom: 10, scale: 1.08, tilt: -2 },
    { x: 34, bottom: 53, scale: .9, tilt: 2 },
    { x: 66, bottom: 52, scale: .92, tilt: -1 },
    { x: 50, bottom: 96, scale: .72, tilt: 1 },
    { x: 23, bottom: 13, scale: 1.02, tilt: -3 },
    { x: 77, bottom: 13, scale: 1.04, tilt: 3 },
    { x: 29, bottom: 88, scale: .68, tilt: 2 },
    { x: 71, bottom: 87, scale: .7, tilt: -2 },
    { x: 14, bottom: 42, scale: .82, tilt: 3 },
    { x: 86, bottom: 41, scale: .8, tilt: -3 },
    { x: 41, bottom: 0, scale: 1.15, tilt: 2 },
    { x: 62, bottom: 1, scale: 1.18, tilt: -2 },
  ];

  return (
    <div className="island-scene" aria-label={`ETF 小森林：${fullPlants} 株完整植物${remainder ? "，另有一株正在長大" : ""}；${name}已經存給未來 ${money.format(futurePrincipal)}，現在成長為 ${money.format(futureValue)}`}>
      <div className="sun" />
      <div className="island-ground" />
      <div className={`island-garden species-${species}`} aria-hidden="true">
        {Array.from({ length: visualCount }, (_, index) => {
          const growing = index === fullPlants && remainder > 0 && fullPlants < visualCount;
          const position = forestLayout[index];
          const growthScale = growing ? 0.5 + (remainder / 1000) * 0.5 : forestMaturity;
          return <span key={index} className={growing ? "is-growing" : ""} style={{ "--plant-x": `${position.x}%`, "--plant-bottom": `${position.bottom}px`, "--plant-scale": position.scale * growthScale, "--plant-tilt": `${position.tilt}deg`, "--plant-depth": 120 - position.bottom } as React.CSSProperties}>{selected.emoji}</span>;
        })}
        {!visualCount && <span className="garden-seed">🌱</span>}
      </div>
      <details className="garden-picker">
        <summary><span>選擇樹種</span><b>{selected.emoji} {selected.label}</b></summary>
        <div>
          {gardenOptions.map((item) => (
            <button
              key={item.value}
              type="button"
              className={item.value === species ? "is-active" : ""}
              aria-label={item.label}
              aria-pressed={item.value === species}
              title={item.label}
              disabled={busy}
              onClick={() => onChange(item.value)}
            >{item.emoji}</button>
          ))}
        </div>
      </details>
      <span className="scene-total">
        <span className="scene-total-avatar"><ProfileAvatar avatar={avatar} /></span>
        <span className="scene-total-copy">
          <span>{name}已經存給未來 <b>{money.format(futurePrincipal)}</b></span>
          <span>現在成長為 <strong>{money.format(futureValue)}</strong></span>
        </span>
      </span>
    </div>
  );
}

function AssetGrowthChart({
  points,
  current,
  profile,
  dreams,
}: {
  points: AssetPoint[];
  current: number;
  profile: KidProfile;
  dreams: MoneyState["dreamJars"];
}) {
  const maximum = Math.max(100, ...points.map((item) => item.value));
  const ceiling = Math.max(1000, Math.ceil(maximum / 1000) * 1000);
  const chartPoints = points.map((point, index) => {
    const x = points.length === 1 ? 50 : 4 + (index / (points.length - 1)) * 92;
    const y = 4 + (1 - point.value / ceiling) * 88;
    return { ...point, x, y };
  });
  const polyline = chartPoints.map((point) => `${point.x},${point.y}`).join(" ");
  const area = chartPoints.length > 1
    ? `${chartPoints[0].x},92 ${polyline} ${chartPoints[chartPoints.length - 1].x},92`
    : "";
  const firstYear = Number(chartPoints[0]?.month.slice(0, 4) ?? new Date().getFullYear());
  const lastYear = Number(chartPoints[chartPoints.length - 1]?.month.slice(0, 4) ?? firstYear);
  const yearsAccumulating = Math.max(1, lastYear - firstYear + 1);
  return (
    <article className="growth-card">
      <div className="section-heading">
        <div><span className="section-kicker">資產成長</span><h2>總資產折線圖</h2><small className="chart-year-count">從 {firstYear} 年開始 · 累積第 {yearsAccumulating} 年</small></div>
        <strong>{money.format(current)}</strong>
      </div>
      <div className="asset-chart" role="img" aria-label={`橫軸為時間、縱軸為金額；目前總資產 ${money.format(current)}`}>
        <div className="chart-y-axis"><span>{money.format(ceiling)}</span><span>{money.format(Math.round(ceiling / 2))}</span><span>NT$0</span></div>
        <div className="chart-plot">
          <div className="line-chart-stage">
            <svg viewBox="0 0 100 96" preserveAspectRatio="none" aria-hidden="true">
              <line x1="0" y1="4" x2="100" y2="4" />
              <line x1="0" y1="48" x2="100" y2="48" />
              <line x1="0" y1="92" x2="100" y2="92" />
              {area && <polygon points={area} />}
              {polyline && <polyline points={polyline} />}
            </svg>
            {chartPoints.map((point) => (
              <i className="chart-point" key={point.month} title={`${point.month}：${money.format(point.value)}`} style={{ left: `${point.x}%`, top: `${point.y}%` }} />
            ))}
          </div>
          <div className="chart-x-axis">{chartPoints.map((point) => <span key={point.month}><b>{point.label}</b><small>{point.month.slice(0, 4)}</small></span>)}</div>
        </div>
      </div>
      {dreams.length ? (
        <div className="growth-dreams">
          <div><span>夢想罐進度</span><Link href="/dreams">查看夢想 →</Link></div>
          {dreams.map((dream) => {
            const saved = dream.kind === "short" ? profile.spendingBalance : profile.bankBalance + profile.marketValue;
            const percent = Math.min(100, dream.targetAmount ? saved / dream.targetAmount * 100 : 0);
            return (
              <Link href="/dreams" className={`growth-dream kind-${dream.kind}`} key={dream.id}>
                <span><b>{dream.title}</b><small>{dream.kind === "short" ? "短期 · 撲滿" : "長期 · 爸媽銀行＋ETF"}</small></span>
                <i><em style={{ width: `${percent}%` }} /></i>
                <strong>{Math.round(percent)}%</strong>
              </Link>
            );
          })}
        </div>
      ) : (
        <Link className="growth-dream-empty" href="/dreams"><span>☁</span><b>放進一個想完成的夢想</b><small>建立夢想罐 →</small></Link>
      )}
    </article>
  );
}

function Rule({ number, title, text }: { number: string; title: string; text: string }) {
  return <article className="rule"><span>{number}</span><div><h3>{title}</h3><p>{text}</p></div></article>;
}

function activityIcon(kind: string): string {
  if (kind === "reward") return "★";
  if (kind === "etf" || kind === "stock-buy") return "↗";
  if (kind === "project") return "✓";
  if (kind === "savings-transfer") return "🌱";
  if (kind === "dream") return "☁";
  if (kind === "harvest") return "福";
  if (kind === "market-update") return "≈";
  if (kind === "spend") return "−";
  if (kind === "welcome") return "♡";
  return "+";
}

function projectStatus(status: string, name?: string): string {
  if (status === "claimed") return `${name ?? "小朋友"}進行中`;
  if (status === "waiting") return "等待家長確認";
  if (status === "completed") return "已完成";
  return "可以認領";
}
