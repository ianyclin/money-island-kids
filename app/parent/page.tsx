"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { InfoTip } from "../info-tip";
import { MoneyStateGate, moneyThemeStyle, revalidateMoneyState, setMoneyStateCache, useMoneyStateCache, useSelectedProfile } from "../money-state-cache";
import type { AnnualHarvest, InvestmentPurchase, MoneyState } from "../money-types";
import { PrimaryNav } from "../primary-nav";
import { ProfileAvatar } from "../profile-avatar";
import { StatusToast, useStatusToast } from "../status-toast";
import { DeviceTrustPanel } from "./device-trust-panel";

const money = new Intl.NumberFormat("zh-TW", {
  style: "currency",
  currency: "TWD",
  maximumFractionDigits: 0,
});

function today(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

type OperationErrorScope = "profile" | "accounts" | "projects" | "purchase" | "holdings" | "harvest" | "backup";

function savedStatus(state: MoneyState, message: string): { message: string; tone: "success" | "waiting" } {
  if (state.backupHealth?.status === "failed") {
    return { message: `${message}；雲端備份稍後重試`, tone: "waiting" };
  }
  if (state.backupHealth?.status === "pending") {
    return { message: `${message}；雲端副本會在背景完成`, tone: "success" };
  }
  return { message, tone: "success" };
}

export default function ParentInvestmentPage() {
  const { state, error: stateError } = useMoneyStateCache();
  const { profile, chooseProfile: selectProfile } = useSelectedProfile(state?.profiles ?? []);
  const [symbol, setSymbol] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState<"ETF" | "股票">("ETF");
  const [units, setUnits] = useState("");
  const [totalCost, setTotalCost] = useState("");
  const [purchaseDate, setPurchaseDate] = useState(today());
  const [note, setNote] = useState("");
  const [purchaseOperationId, setPurchaseOperationId] = useState(() => crypto.randomUUID());
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("資料異動後會自動備份");
  const [operationError, setOperationError] = useState<{ scope: OperationErrorScope; message: string } | null>(null);
  const [pinStatus, setPinStatus] = useState<"loading" | "setup" | "locked" | "unlocked">("loading");
  const [parentPin, setParentPin] = useState("");
  const [pinError, setPinError] = useState("");
  const [pinChangeOpen, setPinChangeOpen] = useState(false);
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmNewPin, setConfirmNewPin] = useState("");
  const [marketValues, setMarketValues] = useState<Record<string, string>>({});
  const [harvestHoldingId, setHarvestHoldingId] = useState("");
  const [soldUnits, setSoldUnits] = useState("");
  const [netProceeds, setNetProceeds] = useState("");
  const [destinationDreamId, setDestinationDreamId] = useState("");
  const [saleDate, setSaleDate] = useState(today());
  const [harvestNote, setHarvestNote] = useState("");
  const [harvestConfirmed, setHarvestConfirmed] = useState(false);
  const [parentBusy, setParentBusy] = useState("");
  const [presetId, setPresetId] = useState("");
  const [presetSymbol, setPresetSymbol] = useState("");
  const [presetName, setPresetName] = useState("");
  const [presetCategory, setPresetCategory] = useState<"ETF" | "股票">("ETF");
  const [presetSort, setPresetSort] = useState("");
  const [piggyBalance, setPiggyBalance] = useState("");
  const [piggyNote, setPiggyNote] = useState("");
  const [projectId, setProjectId] = useState("");
  const [projectTitle, setProjectTitle] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [projectReward, setProjectReward] = useState("");
  const [projectEditorOpen, setProjectEditorOpen] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [profilePhoto, setProfilePhoto] = useState<File | null>(null);
  const [profilePreview, setProfilePreview] = useState("");
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const [savingsRate, setSavingsRate] = useState(30);
  const [quoteMeta, setQuoteMeta] = useState<{ updatedAt: string; source: string } | null>(null);
  const [editingPurchaseId, setEditingPurchaseId] = useState("");
  const [editPurchaseUnits, setEditPurchaseUnits] = useState("");
  const [editPurchaseCost, setEditPurchaseCost] = useState("");
  const [editPurchaseDate, setEditPurchaseDate] = useState("");
  const [editPurchaseNote, setEditPurchaseNote] = useState("");
  const [editingHarvestId, setEditingHarvestId] = useState("");
  const [editHarvestSoldUnits, setEditHarvestSoldUnits] = useState("");
  const [editHarvestNetProceeds, setEditHarvestNetProceeds] = useState("");
  const [editHarvestDreamId, setEditHarvestDreamId] = useState("");
  const [editHarvestSaleDate, setEditHarvestSaleDate] = useState("");
  const [editHarvestNote, setEditHarvestNote] = useState("");
  const { toast, showStatus, dismissStatus } = useStatusToast();

  useEffect(() => {
    if (stateError) showStatus("同步失敗，畫面先保留上次的資料", "error");
  }, [showStatus, stateError]);

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

  const holdings = useMemo(
    () => state && profile ? state.holdings.filter((item) => item.profileId === profile.id) : [],
    [profile, state],
  );
  const purchases = useMemo(
    () => state && profile ? state.purchases.filter((item) => item.profileId === profile.id).slice(0, 8) : [],
    [profile, state],
  );
  const shortDreams = useMemo(
    () => state && profile ? state.dreamJars.filter((item) => item.profileId === profile.id && item.kind === "short" && item.status === "active") : [],
    [profile, state],
  );
  const harvestHistory = useMemo(
    () => state && profile
      ? state.harvests
        .filter((item) => item.profileId === profile.id)
        .sort((a, b) => b.saleDate.localeCompare(a.saleDate) || b.createdAt.localeCompare(a.createdAt))
      : [],
    [profile, state],
  );
  const waitingProjects = (state?.projects ?? []).filter((item) => item.status === "waiting");
  const pendingSavingsTransfers = (state?.savingsTransfers ?? []).filter((item) => item.status === "pending");
  const currentYear = Number(today().slice(0, 4));
  const harvestedThisYear = (state?.harvests ?? []).some((item) => item.profileId === profile?.id && item.year === currentYear);
  const plannedCost = Math.max(0, Math.round(Number(totalCost) || 0));
  const maxHarvest = Math.floor((profile?.marketValue ?? 0) * .05);
  const holdingIds = holdings.map((holding) => holding.id).join("\n");
  const shortDreamIds = shortDreams.map((dream) => dream.id).join("\n");
  const firstHoldingId = holdings[0]?.id ?? "";
  const firstShortDreamId = shortDreams[0]?.id ?? "";

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const validHoldingIds = new Set(holdingIds.split("\n").filter(Boolean));
      const validDreamIds = new Set(shortDreamIds.split("\n").filter(Boolean));
      setHarvestHoldingId((current) => current && validHoldingIds.has(current) ? current : firstHoldingId);
      setDestinationDreamId((current) => !current || validDreamIds.has(current) ? current : firstShortDreamId);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [firstHoldingId, firstShortDreamId, holdingIds, shortDreamIds]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSoldUnits("");
      setNetProceeds("");
      setHarvestNote("");
      setHarvestConfirmed(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [profile?.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPiggyBalance(String(profile?.spendingBalance ?? 0));
      setPiggyNote("");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [profile?.id, profile?.spendingBalance]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setProfileName(profile?.name ?? "");
      setProfilePhoto(null);
      setProfilePreview(profile?.avatar ?? "");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [profile?.id, profile?.name, profile?.avatar]);

  useEffect(() => {
    const timer = window.setTimeout(() => setSavingsRate(state?.savingsRate ?? 30), 0);
    return () => window.clearTimeout(timer);
  }, [state?.savingsRate]);

  if (!state || !profile) return <MoneyStateGate error={stateError} onRetry={() => void revalidateMoneyState().catch(() => undefined)} />;

  function announce(message: string, tone: "success" | "waiting" = "success") {
    setNotice(message);
    showStatus(message, tone);
  }

  function clearOperationError(scope?: OperationErrorScope) {
    setOperationError((current) => !scope || current?.scope === scope ? null : current);
  }

  function reportOperationError(scope: OperationErrorScope, caught: unknown, fallback: string) {
    const message = caught instanceof Error ? caught.message : fallback;
    setOperationError({ scope, message });
    showStatus(message, "error");
  }

  function chooseProfile(id: string) {
    selectProfile(id);
    setProfileEditorOpen(true);
    setEditingPurchaseId("");
    setEditingHarvestId("");
    clearOperationError();
    setConfirmed(false);
    setHarvestConfirmed(false);
  }

  function openProfileEditor(id: string) {
    if (id === profile?.id) {
      setProfileEditorOpen((current) => {
        const next = !current;
        if (next) window.setTimeout(() => document.querySelector("#profile-editor")?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 0);
        return next;
      });
      return;
    }
    selectProfile(id);
    setProfileEditorOpen(true);
    window.setTimeout(() => document.querySelector("#profile-editor")?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 0);
  }

  function choosePreset(nextSymbol: string, nextName: string, nextCategory: "ETF" | "股票") {
    setSymbol(nextSymbol);
    setName(nextName);
    setCategory(nextCategory);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    clearOperationError("purchase");
    try {
      const response = await fetch("/api/investments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "purchase",
          profileId: profile!.id,
          symbol,
          name,
          category,
          units: Number(units),
          totalCost: plannedCost,
          purchaseDate,
          note,
          operationId: purchaseOperationId,
          parentPin,
        }),
      });
      const result = await response.json() as MoneyState & { error?: string };
      if (!response.ok) throw new Error(result.error || "儲存失敗");
      setMoneyStateCache(result);
      setUnits("");
      setTotalCost("");
      setNote("");
      setPurchaseOperationId(crypto.randomUUID());
      setConfirmed(false);
      const saved = savedStatus(result, `${profile!.name}的買入紀錄已經存好了`);
      announce(saved.message, saved.tone);
    } catch (caught) {
      reportOperationError("purchase", caught, "儲存失敗");
    } finally {
      setSaving(false);
    }
  }

  async function submitPin(event: FormEvent) {
    event.preventDefault();
    setParentBusy("pin");
    setPinError("");
    try {
      const response = await fetch("/api/parent-pin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: pinStatus === "setup" ? "setup" : "verify", pin: parentPin }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "操作碼驗證失敗");
      setPinStatus("unlocked");
      announce(pinStatus === "setup" ? "家長操作碼已設定" : "家長區已解鎖；關閉頁面後會再次上鎖");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "操作碼驗證失敗";
      setPinError(message);
      showStatus(message, "error");
    } finally {
      setParentBusy("");
    }
  }

  async function changePin(event: FormEvent) {
    event.preventDefault();
    setPinError("");
    if (newPin !== confirmNewPin) {
      setPinError("兩次輸入的新操作碼不一致");
      showStatus("兩次輸入的新操作碼不一致", "error");
      return;
    }
    setParentBusy("pin-change");
    try {
      const response = await fetch("/api/parent-pin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "change", pin: currentPin, newPin }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "無法變更操作碼");
      setParentPin(newPin);
      setCurrentPin("");
      setNewPin("");
      setConfirmNewPin("");
      setPinChangeOpen(false);
      announce("家長操作碼已更新；下次請使用新操作碼解鎖");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "無法變更操作碼";
      setPinError(message);
      showStatus(message, "error");
    } finally {
      setParentBusy("");
    }
  }

  async function parentRequest(path: string, payload: Record<string, unknown>, busyId: string, scope: OperationErrorScope) {
    setParentBusy(busyId);
    clearOperationError(scope);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, parentPin }),
      });
      const result = await response.json() as MoneyState & { error?: string };
      if (!response.ok) throw new Error(result.error || "家長操作儲存失敗");
      setMoneyStateCache(result);
      const saved = savedStatus(result, "家長操作已完成，帳本已更新");
      announce(saved.message, saved.tone);
      return true;
    } catch (caught) {
      reportOperationError(scope, caught, "家長操作儲存失敗");
      return false;
    } finally {
      setParentBusy("");
    }
  }

  async function saveSavingsRate(event: FormEvent) {
    event.preventDefault();
    const ok = await parentRequest("/api/settings", { savingsRate }, "savings-rate", "accounts");
    if (ok) announce(`預先儲蓄比例已調整為 ${savingsRate}%`);
  }

  async function approveProject(projectId: string) {
    await parentRequest("/api/projects", { action: "approve", projectId, profileId: profile!.id }, projectId, "projects");
  }

  async function resolveSavingsTransfer(transferId: string, action: "approve" | "reject") {
    const ok = await parentRequest("/api/savings-transfers", {
      action,
      transferId,
      operationId: crypto.randomUUID(),
    }, `savings-${action}-${transferId}`, "accounts");
    if (ok) announce(action === "approve" ? "已確認存入爸媽銀行" : "這次自主多存沒有執行");
  }

  async function updateMarketValue(holdingId: string) {
    const next = Math.round(Number(marketValues[holdingId]));
    const ok = await parentRequest("/api/market-value", { holdingId, marketValue: next }, `market-${holdingId}`, "holdings");
    if (ok) setMarketValues({ ...marketValues, [holdingId]: "" });
  }

  async function updateMarketQuotes() {
    setParentBusy("market-quotes");
    clearOperationError("holdings");
    try {
      const response = await fetch("/api/market-quotes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "parent",
          profileId: profile!.id,
          parentPin,
        }),
      });
      const result = await response.json() as ({ state?: MoneyState; updatedAt?: string; source?: string; error?: string } & Partial<MoneyState>);
      if (!response.ok) throw new Error(result.error || "無法更新最新收盤價");
      const nextState = result.state ?? (Array.isArray(result.profiles) ? result as MoneyState : null);
      if (!nextState) throw new Error("行情更新結果格式不正確");
      setMoneyStateCache(nextState);
      setQuoteMeta({
        updatedAt: result.updatedAt ?? new Date().toISOString(),
        source: result.source ?? "市場行情",
      });
      announce("最新可用收盤價已更新");
    } catch (caught) {
      reportOperationError("holdings", caught, "無法更新最新收盤價");
    } finally {
      setParentBusy("");
    }
  }

  function editPurchase(item: InvestmentPurchase) {
    setEditingPurchaseId(item.id);
    setEditPurchaseUnits(String(item.units));
    setEditPurchaseCost(String(item.totalCost));
    setEditPurchaseDate(item.purchaseDate);
    setEditPurchaseNote(item.note);
    clearOperationError("holdings");
  }

  function closePurchaseEditor() {
    setEditingPurchaseId("");
    setEditPurchaseUnits("");
    setEditPurchaseCost("");
    setEditPurchaseDate("");
    setEditPurchaseNote("");
  }

  async function correctPurchase(event: FormEvent) {
    event.preventDefault();
    if (!editingPurchaseId) return;
    const busyId = `purchase-correct-${editingPurchaseId}`;
    const ok = await parentRequest("/api/investments", {
      action: "correct",
      purchaseId: editingPurchaseId,
      units: Number(editPurchaseUnits),
      totalCost: Number(editPurchaseCost),
      purchaseDate: editPurchaseDate,
      note: editPurchaseNote,
    }, busyId, "holdings");
    if (ok) {
      closePurchaseEditor();
      announce("買入紀錄已更正，相關餘額與持股也已一起校正");
    }
  }

  async function voidPurchase(item: InvestmentPurchase) {
    const confirmedVoid = window.confirm(`確定要撤銷 ${item.purchaseDate} 的 ${item.symbol} 買入嗎？\n\n系統會一併還原爸媽銀行、持股與成本；若後續已有賣出紀錄，系統會為了帳本安全而拒絕撤銷。`);
    if (!confirmedVoid) return;
    const ok = await parentRequest("/api/investments", {
      action: "void",
      purchaseId: item.id,
    }, `purchase-void-${item.id}`, "holdings");
    if (ok) {
      if (editingPurchaseId === item.id) closePurchaseEditor();
      announce("買入紀錄已撤銷，相關餘額與持股也已還原");
    }
  }

  async function submitHarvest(event: FormEvent) {
    event.preventDefault();
    const ok = await parentRequest("/api/harvest", {
      action: "record",
      profileId: profile!.id,
      holdingId: harvestHoldingId,
      soldUnits: Number(soldUnits),
      netProceeds: Number(netProceeds),
      destinationDreamId: destinationDreamId || null,
      saleDate,
      note: harvestNote,
    }, "harvest", "harvest");
    if (ok) {
      setSoldUnits("");
      setNetProceeds("");
      setHarvestNote("");
      setHarvestConfirmed(false);
      announce("過年投資收成已經記在帳本裡");
    }
  }

  function editHarvest(item: AnnualHarvest) {
    setEditingHarvestId(item.id);
    setEditHarvestSoldUnits(String(item.soldUnits));
    setEditHarvestNetProceeds(String(item.netProceeds));
    setEditHarvestDreamId(item.destinationDreamId ?? "");
    setEditHarvestSaleDate(item.saleDate);
    setEditHarvestNote(item.note);
    clearOperationError("harvest");
  }

  function closeHarvestEditor() {
    setEditingHarvestId("");
    setEditHarvestSoldUnits("");
    setEditHarvestNetProceeds("");
    setEditHarvestDreamId("");
    setEditHarvestSaleDate("");
    setEditHarvestNote("");
  }

  async function correctHarvest(event: FormEvent) {
    event.preventDefault();
    if (!editingHarvestId) return;
    const ok = await parentRequest("/api/harvest", {
      action: "correct",
      harvestId: editingHarvestId,
      soldUnits: Number(editHarvestSoldUnits),
      netProceeds: Number(editHarvestNetProceeds),
      destinationDreamId: editHarvestDreamId || null,
      saleDate: editHarvestSaleDate,
      note: editHarvestNote,
    }, `harvest-correct-${editingHarvestId}`, "harvest");
    if (ok) {
      closeHarvestEditor();
      announce("過年收成已更正，撲滿、持股與投入成本也已一起校正");
    }
  }

  async function voidHarvest(item: AnnualHarvest) {
    const confirmedVoid = window.confirm(`確定要撤銷 ${item.year} 年的過年投資收成嗎？\n\n系統會退回撲滿裡的 ${money.format(item.netProceeds)}，並恢復對應持股與投入成本。若後續餘額不足，系統會為了帳本安全而拒絕撤銷。`);
    if (!confirmedVoid) return;
    const ok = await parentRequest("/api/harvest", {
      action: "void",
      harvestId: item.id,
    }, `harvest-void-${item.id}`, "harvest");
    if (ok) {
      if (editingHarvestId === item.id) closeHarvestEditor();
      announce("過年收成已撤銷，撲滿、持股與投入成本也已還原");
    }
  }

  function editPreset(id: string) {
    const preset = state!.investmentPresets.find((item) => item.id === id);
    if (!preset) return;
    setPresetId(preset.id);
    setPresetSymbol(preset.symbol);
    setPresetName(preset.name);
    setPresetCategory(preset.category);
    setPresetSort(String(preset.sortOrder));
  }

  async function savePreset(event: FormEvent) {
    event.preventDefault();
    const ok = await parentRequest("/api/presets", {
      action: presetId ? "update" : "create",
      presetId: presetId || undefined,
      symbol: presetSymbol,
      name: presetName,
      category: presetCategory,
      sortOrder: Number(presetSort || state!.investmentPresets.length + 1),
    }, "preset", "holdings");
    if (ok) { setPresetId(""); setPresetSymbol(""); setPresetName(""); setPresetCategory("ETF"); setPresetSort(""); }
  }

  async function removePreset(id: string) {
    await parentRequest("/api/presets", { action: "delete", presetId: id }, `preset-delete-${id}`, "holdings");
  }

  async function savePiggy(event: FormEvent) {
    event.preventDefault();
    const ok = await parentRequest("/api/piggy-bank", { profileId: profile!.id, balance: Number(piggyBalance), note: piggyNote }, "piggy", "accounts");
    if (ok) {
      setPiggyNote("");
      announce("撲滿金額已經校正");
    }
  }

  function chooseProfilePhoto(file?: File) {
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      reportOperationError("profile", new Error("照片請小於 4 MB"), "照片請小於 4 MB");
      return;
    }
    clearOperationError("profile");
    setProfilePhoto(file);
    const reader = new FileReader();
    reader.onload = () => setProfilePreview(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  }

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    setParentBusy("profile");
    clearOperationError("profile");
    try {
      const form = new FormData();
      form.set("profileId", profile!.id);
      form.set("name", profileName);
      form.set("parentPin", parentPin);
      if (profilePhoto) form.set("photo", profilePhoto);
      const response = await fetch("/api/profile", { method: "POST", body: form });
      const result = await response.json() as MoneyState & { error?: string };
      if (!response.ok) throw new Error(result.error || "名字或照片儲存失敗");
      setMoneyStateCache(result);
      setProfilePhoto(null);
      announce(`${profileName}的名字與照片已經存好了`);
    } catch (caught) {
      reportOperationError("profile", caught, "名字或照片儲存失敗");
    } finally {
      setParentBusy("");
    }
  }

  function resetProjectForm() {
    setProjectId("");
    setProjectTitle("");
    setProjectDescription("");
    setProjectReward("");
    setProjectEditorOpen(false);
  }

  function editProject(nextId: string) {
    const project = state!.projects.find((item) => item.id === nextId);
    if (!project || project.status !== "open") return;
    setProjectId(project.id);
    setProjectTitle(project.title);
    setProjectDescription(project.description);
    setProjectReward(String(project.reward));
    setProjectEditorOpen(true);
    window.setTimeout(() => document.getElementById("project-editor")?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
  }

  async function saveProject(event: FormEvent) {
    event.preventDefault();
    const ok = await parentRequest("/api/projects", {
      action: projectId ? "update" : "create",
      projectId: projectId || undefined,
      title: projectTitle,
      description: projectDescription,
      reward: Number(projectReward),
    }, "project-save", "projects");
    if (ok) resetProjectForm();
  }

  async function downloadBackup(kind: "account" | "portable" = "account") {
    clearOperationError("backup");
    try {
      const response = await fetch("/api/backups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: kind === "portable" ? "export-portable" : "export", parentPin }),
      });
      const result = await response.json() as Record<string, unknown> & { error?: string };
      if (!response.ok) throw new Error(result.error || "備份下載失敗");

      const fileName = `${kind === "portable" ? "小小理財島完整可攜備份" : "小小理財島帳本備份"}-${new Date().toISOString().slice(0, 10)}.json`;
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = fileName;
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
      showStatus(kind === "portable" ? "完整可攜備份已送到下載項目" : "帳本備份已送到下載項目", "success");
    } catch (caught) {
      reportOperationError("backup", caught, "備份下載失敗");
      throw caught;
    }
  }

  return (
    <main
      className="parent-shell"
      data-kid={profile.id}
      style={moneyThemeStyle(profile)}
    >
      <header className="parent-topbar">
        <Link className="brand" href="/" aria-label="回到小小理財島">
          <span className="brand-mark" aria-hidden="true">¢</span>
          <span><strong>小小理財島</strong><small>家長專區</small></span>
        </Link>
        <PrimaryNav active="parent" />
      </header>

      <section className="parent-hero">
        <div>
          <div className="heading-help"><span className="parent-kicker">所有家長功能集中在這裡</span><InfoTip>先解鎖一次，再依序處理撲滿、家庭小專案、真實投資與裝置信任。</InfoTip></div>
          <h1>管理帳本、專案與投資，<br /><em>孩子頁面保持簡單。</em></h1>
        </div>
      </section>

      <section className={pinStatus === "unlocked" ? "parent-lock-card is-unlocked" : "parent-lock-card"}>
        <span className="lock-icon" aria-hidden="true">{pinStatus === "unlocked" ? "✓" : "🔒"}</span>
        <div><b>{pinStatus === "setup" ? "第一次使用：設定家長操作碼" : pinStatus === "unlocked" ? "家長區已解鎖" : "輸入家長操作碼"}</b><small>{pinStatus === "setup" ? "使用 4–8 位數字；操作碼不會顯示在孩子頁面。" : pinStatus === "unlocked" ? "現在可以使用本頁所有家長功能。" : "編輯帳本、專案、投資與裝置信任都需要驗證。"}</small></div>
        {pinStatus !== "unlocked" && pinStatus !== "loading" && <form onSubmit={submitPin}><input type="password" inputMode="numeric" pattern="[0-9]{4,8}" minLength={4} maxLength={8} value={parentPin} onChange={(event) => setParentPin(event.target.value.replace(/\D/g, ""))} placeholder="4–8 位數字" required /><button disabled={parentBusy === "pin"}>{parentBusy === "pin" ? "驗證中…" : pinStatus === "setup" ? "設定並解鎖" : "解鎖"}</button></form>}
        {pinStatus === "unlocked" && <button className="pin-change-trigger" type="button" aria-expanded={pinChangeOpen} onClick={() => { setPinChangeOpen(!pinChangeOpen); setPinError(""); }}>變更操作碼 {pinChangeOpen ? "−" : "＋"}</button>}
        {pinStatus === "unlocked" && pinChangeOpen && <form className="pin-change-form" onSubmit={changePin}>
          <label>目前操作碼<input type="password" inputMode="numeric" pattern="[0-9]{4,8}" minLength={4} maxLength={8} value={currentPin} onChange={(event) => setCurrentPin(event.target.value.replace(/\D/g, ""))} required /></label>
          <label>新操作碼<input type="password" inputMode="numeric" pattern="[0-9]{4,8}" minLength={4} maxLength={8} value={newPin} onChange={(event) => setNewPin(event.target.value.replace(/\D/g, ""))} required /></label>
          <label>再輸入一次<input type="password" inputMode="numeric" pattern="[0-9]{4,8}" minLength={4} maxLength={8} value={confirmNewPin} onChange={(event) => setConfirmNewPin(event.target.value.replace(/\D/g, ""))} required /></label>
          <button disabled={parentBusy === "pin-change"}>{parentBusy === "pin-change" ? "更新中…" : "確認變更"}</button>
        </form>}
        {pinError && <p className="form-error">{pinError}</p>}
      </section>

      <div className="parent-settings-row">
      <details className="parent-guide">
        <summary>
          <span aria-hidden="true">🧭</span>
          <div><small>第一次使用可以從這裡開始</small><b>小小理財島：理念與操作指南</b></div>
          <strong><i>查看指南</i><i>收起指南</i></strong>
        </summary>
        <div className="parent-guide-content">
          <section className="guide-principle">
            <span>我們想教的不是「賺最多」</span>
            <h2>錢有限，所以每一次安排，都是在練習自己做選擇。</h2>
            <p>先照顧未來的自己，再安排現在想做的事；記帳與回顧是用來觀察和調整，不是考試，也不因為選錯就處罰。</p>
          </section>

          <section className="guide-section guide-finance-section">
            <span className="parent-kicker">五個核心理財觀念</span>
            <div className="guide-finance-grid">
              <article><b>1</b><h3>錢有限</h3><p>選擇一件想要的東西，也代表其他東西需要等待。</p></article>
              <article><b>2</b><h3>先存再花</h3><p>每次收到錢，先依家庭比例留一部分給未來的自己。</p></article>
              <article><b>3</b><h3>錢有不同任務</h3><p>撲滿、爸媽銀行與 ETF 是不同用途；互相搬動不是又賺一筆。</p></article>
              <article><b>4</b><h3>投資會波動</h3><p>資產成長可能來自投入，也可能來自 ETF 漲跌，沒有保證。</p></article>
              <article><b>5</b><h3>回顧再調整</h3><p>每月看看選擇的結果，找到下次想保留或換個做法的地方。</p></article>
            </div>
          </section>

          <section className="guide-section">
            <span className="parent-kicker">第一次設定</span>
            <div className="guide-step-grid">
              <article><b>1</b><h3>建立家庭</h3><p>保存家庭代碼、家庭密碼和離線救援碼，再把常用的 iPad 或手機設為信任裝置。</p></article>
              <article><b>2</b><h3>設定孩子資料</h3><p>編輯孩子的名字、照片與撲滿金額，並調整預先儲蓄比例；預設是 30%。</p></article>
              <article><b>3</b><h3>從第一筆錢開始</h3><p>孩子記錄收到的零用錢，系統會依比例分到「留給未來」與「可以自己決定」。</p></article>
              <article><b>4</b><h3>一起核對</h3><p>家長定期確認實體金額、爸媽銀行與真實投資；需要修正時再解鎖家長功能。</p></article>
            </div>
          </section>

          <section className="guide-section">
            <span className="parent-kicker">四個頁面怎麼用</span>
            <div className="guide-page-grid">
              <article><b>孩子首頁</b><p>記錄收到的錢與花費，查看撲滿、爸媽銀行、ETF 小森林和最近紀錄。</p></article>
              <article><b>夢想與回顧</b><p>先看看每月存錢、資產與支出，再保留一個短期夢想和一個長期夢想。</p></article>
              <article><b>所有紀錄</b><p>依名稱、日期或類型搜尋。家長解鎖後可以編輯或撤銷可調整的紀錄。</p></article>
              <article><b>家長區</b><p>管理比例、照片、撲滿、家庭小專案、真實投資、信任裝置與資料備份。</p></article>
            </div>
          </section>

          <section className="guide-section guide-account-section">
            <span className="parent-kicker">三個帳戶的意思</span>
            <div className="guide-account-grid">
              <article><span>🐷</span><div><b>撲滿</b><p>孩子可以自己決定的錢，也是短期夢想的進度來源。</p></div></article>
              <article><span>🏦</span><div><b>爸媽銀行</b><p>先存下的錢、自主多存與每月自動加入的爸媽存錢獎勵，準備留給較久以後。</p></div></article>
              <article><span>🌳</span><div><b>ETF 小森林</b><p>爸媽實際買入後再記錄，市值會隨家長更新的真實金額變化。</p></div></article>
            </div>
            <p className="guide-balance-note">總資產＝撲滿＋爸媽銀行＋ETF 小森林；帳戶之間搬錢不代表又賺到一筆錢。</p>
          </section>

          <section className="guide-section guide-rhythm">
            <div><span className="parent-kicker">建議的家庭節奏</span><ul><li>收到或花錢時：當下簡單記一筆。</li><li>每週：花 5 分鐘一起核對帳本。</li><li>每月：完成一次回顧，聊聊最滿意的選擇。</li><li>每年過年：可以選擇不提領，或最多收成投資的 5%。</li></ul></div>
            <div><span className="parent-kicker">資料與救援</span><ul><li>每次異動會自動保存雲端版本。</li><li>家長可定期下載 JSON 備份，也能上傳還原。</li><li>忘記家庭資料時，可用離線救援碼，或三個孩子名稱＋家長操作碼找回。</li><li>實體「好棒印章」不換現金，繼續保留生活鼓勵的味道。</li></ul></div>
          </section>
        </div>
      </details>

      <form className="family-settings-panel savings-inline-panel" onSubmit={saveSavingsRate}>
        <span className="settings-panel-copy"><small>全家共用設定</small><b>預先儲蓄比例</b></span>
        <div className="savings-stepper" aria-label="調整預先儲蓄比例">
          <button type="button" aria-label="減少 5%" disabled={pinStatus !== "unlocked" || savingsRate <= 0} onClick={() => setSavingsRate((value) => Math.max(0, value - 5))}>−</button>
          <output aria-live="polite">{savingsRate}%</output>
          <button type="button" aria-label="增加 5%" disabled={pinStatus !== "unlocked" || savingsRate >= 100} onClick={() => setSavingsRate((value) => Math.min(100, value + 5))}>＋</button>
        </div>
        <button className="savings-rate-save" disabled={pinStatus !== "unlocked" || parentBusy === "savings-rate" || savingsRate === state.savingsRate}>{parentBusy === "savings-rate" ? "儲存中…" : savingsRate === state.savingsRate ? "已儲存" : "儲存"}</button>
      </form>

      <button className={profileEditorOpen ? "profile-settings-trigger is-open" : "profile-settings-trigger"} type="button" aria-expanded={profileEditorOpen} onClick={() => openProfileEditor(profile.id)}>
        <span><ProfileAvatar avatar={profile.avatar} /></span>
        <span><small>孩子資料</small><b>編輯{profile.name}</b></span>
        <strong>{profileEditorOpen ? "收起 −" : "編輯 ＋"}</strong>
      </button>
      </div>

      {profileEditorOpen && <section className="profile-editor-panel" id="profile-editor">
        <div className="parent-profile-row profile-editor-switcher" aria-label="選擇要編輯的小朋友">
          {state.profiles.map((item) => (
            <div className="parent-profile-shell" key={item.id} style={{ "--profile-color": item.accent } as React.CSSProperties}>
              <button
                className={item.id === profile.id ? "parent-profile is-active" : "parent-profile"}
                type="button"
                onClick={() => item.id === profile.id ? openProfileEditor(item.id) : chooseProfile(item.id)}
                aria-pressed={item.id === profile.id}
                aria-expanded={item.id === profile.id}
              >
                <span><ProfileAvatar avatar={item.avatar} /></span><b>{item.name}</b><small>{item.id === profile.id ? "再按一次收起編輯" : "切換並編輯這位小朋友"}</small>
              </button>
            </div>
          ))}
        </div>
        <div className="profile-editor-forms">
          <form className="profile-identity-form" onSubmit={saveProfile}>
            <span className="profile-photo-preview"><ProfileAvatar avatar={profilePreview || profile.avatar} name={profileName || profile.name} /></span>
            <label>顯示名字<input value={profileName} onChange={(event) => setProfileName(event.target.value)} minLength={1} maxLength={12} required /></label>
            <label className="profile-photo-input">選擇照片<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => chooseProfilePhoto(event.target.files?.[0])} /></label>
            <button disabled={pinStatus !== "unlocked" || parentBusy === "profile"}>{parentBusy === "profile" ? "儲存中…" : "儲存照片與名字"}</button>
          </form>
          <form className="profile-piggy-form" onSubmit={savePiggy}>
            <label>撲滿目前金額<input type="number" min="0" max="1000000" inputMode="numeric" value={piggyBalance} onChange={(event) => setPiggyBalance(event.target.value)} required /></label>
            <label>校正原因（選填）<input value={piggyNote} onChange={(event) => setPiggyNote(event.target.value)} placeholder="例如：和實體撲滿核對" maxLength={100} /></label>
            <button disabled={pinStatus !== "unlocked" || parentBusy === "piggy"}>{parentBusy === "piggy" ? "儲存中…" : "儲存撲滿金額"}</button>
          </form>
          {operationError?.scope === "profile" && <p className="form-error">{operationError.message}</p>}
          {operationError?.scope === "accounts" && <p className="form-error">{operationError.message}</p>}
        </div>
      </section>}

      {pendingSavingsTransfers.length > 0 && <section className="parent-approval-strip savings-approval-strip">
        <span className="parent-kicker">等待家長確認</span>
        <h2>🌱 自主多存申請</h2>
        {pendingSavingsTransfers.map((transfer) => {
          const kid = state.profiles.find((item) => item.id === transfer.profileId);
          return <article key={transfer.id}>
            <span>{kid ? <ProfileAvatar avatar={kid.avatar} /> : "🌱"}</span>
            <div><b>{kid?.name ?? "小朋友"}想多存 {money.format(transfer.amount)}</b><small>{transfer.note} · 批准後才會從撲滿轉入爸媽銀行</small></div>
            <div className="savings-approval-actions"><button type="button" disabled={pinStatus !== "unlocked" || parentBusy === `savings-approve-${transfer.id}`} onClick={() => void resolveSavingsTransfer(transfer.id, "approve")}>{parentBusy === `savings-approve-${transfer.id}` ? "處理中…" : "確認存入"}</button><button className="reject-transfer" type="button" disabled={pinStatus !== "unlocked" || parentBusy === `savings-reject-${transfer.id}`} onClick={() => void resolveSavingsTransfer(transfer.id, "reject")}>不執行</button></div>
          </article>;
        })}
      </section>}

      <section className="parent-project-panel" id="projects">
        <div className="parent-project-heading">
          <div className="parent-project-copy"><div className="heading-help"><span className="parent-kicker">家庭小專案</span><InfoTip>只替額外、完整且事前約定的任務設定報酬；日常責任不標價。</InfoTip></div><h2>專案與確認</h2></div>
          <button
            className="project-editor-trigger"
            type="button"
            aria-expanded={projectEditorOpen}
            disabled={pinStatus !== "unlocked"}
            onClick={() => projectEditorOpen ? resetProjectForm() : setProjectEditorOpen(true)}
          >{pinStatus !== "unlocked" ? "解鎖後新增" : projectEditorOpen ? "收起編輯 −" : "新增專案 ＋"}</button>
        </div>
        <div className={projectEditorOpen ? "parent-project-layout is-editor-open" : "parent-project-layout"}>
          {projectEditorOpen && <form className="parent-project-form" id="project-editor" onSubmit={saveProject}>
            <h3>{projectId ? "編輯尚未被接下的專案" : "新增一個小專案"}</h3>
            <label>專案名稱<input value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} placeholder="例如：整理一箱舊玩具" required minLength={2} maxLength={40} /></label>
            <label>完成條件<textarea value={projectDescription} onChange={(event) => setProjectDescription(event.target.value)} placeholder="清楚寫出範圍與成果" required minLength={4} maxLength={180} /></label>
            <label>完成報酬<input type="number" inputMode="numeric" min="10" max="500" step="10" value={projectReward} onChange={(event) => setProjectReward(event.target.value)} required /></label>
            <button className="primary-button full-width" disabled={pinStatus !== "unlocked" || parentBusy === "project-save"}>{parentBusy === "project-save" ? "儲存中…" : projectId ? "儲存修改" : "發布小專案"}</button>
            {projectId && <button className="cancel-preset" type="button" onClick={resetProjectForm}>取消編輯</button>}
          </form>}
          <div className="parent-project-list">
            {waitingProjects.length > 0 && <div className="project-waiting-group"><b>等待家長確認</b>{waitingProjects.map((project) => { const kid = state.profiles.find((item) => item.id === project.assignedProfileId); return <article key={project.id}><span>{kid && <ProfileAvatar avatar={kid.avatar} />}</span><div><strong>{kid?.name} · {project.title}</strong><small>{money.format(project.reward)}，確認後依 {state.savingsRate}% / {100 - state.savingsRate}% 分配</small></div><button disabled={pinStatus !== "unlocked" || parentBusy === project.id} onClick={() => void approveProject(project.id)}>{parentBusy === project.id ? "發放中…" : "確認完成"}</button></article>; })}</div>}
            <div className="project-manage-group"><b>目前專案</b>{state.projects.length ? state.projects.map((project) => <article key={project.id}><div><strong>{project.title}</strong><small>{project.status === "open" ? "尚未接下" : project.status === "claimed" ? "進行中" : project.status === "waiting" ? "等待確認" : "已完成"} · {money.format(project.reward)}</small></div>{project.status === "open" && <button disabled={pinStatus !== "unlocked"} onClick={() => editProject(project.id)}>編輯</button>}</article>) : <p className="project-empty-state">目前沒有家庭小專案，需要時再新增即可。</p>}</div>
          </div>
        </div>
        {operationError?.scope === "projects" && <p className="form-error">{operationError.message}</p>}
      </section>

      <section className="investment-layout" id="investments">
        <details className="investment-form-card">
          <summary className="investment-summary">
            <div><span className="parent-kicker">新增一筆真實買入</span><h2>🌱 爸媽已經買好了嗎？</h2><small>需要記錄券商買入時再展開</small></div>
            <span className="investment-summary-action"><b>記錄買入</b><small className="investment-closed-label">查看或操作 ＋</small><small className="investment-open-label">收起細節 −</small></span>
          </summary>
          <div className="investment-form-content">
          <div className="panel-help"><InfoTip align="right">請依照券商成交結果填寫；總成本包含手續費，會最容易和真實帳戶對得上。</InfoTip></div>

          <div className="preset-row" aria-label="常用標的">
            {state.investmentPresets.map((preset) => <button key={preset.id} type="button" onClick={() => choosePreset(preset.symbol, preset.name, preset.category)}>{preset.symbol}</button>)}
            <span>也可以輸入其他標的</span>
          </div>

          <details className="preset-admin">
            <summary>調整常用標的</summary>
            <div className="preset-list">{state.investmentPresets.map((preset) => <div key={preset.id}><span><b>{preset.symbol}</b><small>{preset.name} · {preset.category}</small></span><button type="button" disabled={pinStatus !== "unlocked"} onClick={() => editPreset(preset.id)}>編輯</button><button type="button" disabled={pinStatus !== "unlocked" || parentBusy === `preset-delete-${preset.id}`} onClick={() => void removePreset(preset.id)}>停用</button></div>)}</div>
            <form onSubmit={savePreset}><div className="form-two-columns"><label><span>標的代號</span><input value={presetSymbol} onChange={(event) => setPresetSymbol(event.target.value.toUpperCase())} placeholder="例如 VT" required maxLength={12} /></label><label><span>類型</span><select value={presetCategory} onChange={(event) => setPresetCategory(event.target.value as "ETF" | "股票")}><option>ETF</option><option>股票</option></select></label></div><label><span>顯示名稱</span><input value={presetName} onChange={(event) => setPresetName(event.target.value)} placeholder="例如 Vanguard Total World" required maxLength={40} /></label><label><span>排序</span><input type="number" min="0" max="100" value={presetSort} onChange={(event) => setPresetSort(event.target.value)} placeholder="數字越小越前面" /></label><button className="primary-button full-width" disabled={pinStatus !== "unlocked" || parentBusy === "preset"}>{parentBusy === "preset" ? "儲存中…" : presetId ? "儲存常用標的修改" : "新增常用標的"}</button>{presetId && <button className="cancel-preset" type="button" onClick={() => { setPresetId(""); setPresetSymbol(""); setPresetName(""); setPresetSort(""); }}>取消編輯</button>}</form>
          </details>

          <form onSubmit={submit}>
            <div className="form-two-columns">
              <label><span>股票代號</span><input value={symbol} onChange={(event) => setSymbol(event.target.value.toUpperCase())} placeholder="例如 00646" required maxLength={12} /></label>
              <label><span>類型</span><select value={category} onChange={(event) => setCategory(event.target.value as "ETF" | "股票")}><option>ETF</option><option>股票</option></select></label>
            </div>
            <label><span>標的名稱</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 元大 S&P 500" required maxLength={40} /></label>
            <div className="form-two-columns">
              <label><span>實際買入股數</span><input type="number" inputMode="decimal" min="0.0001" step="0.0001" value={units} onChange={(event) => setUnits(event.target.value)} placeholder="例如 10" required /></label>
              <label><span>總成本（含費用）</span><input type="number" inputMode="numeric" min="1" max={profile.bankBalance} value={totalCost} onChange={(event) => setTotalCost(event.target.value)} placeholder="NT$" required /></label>
            </div>
            <label><span>買入日期</span><input type="date" value={purchaseDate} onChange={(event) => setPurchaseDate(event.target.value)} required /></label>
            <label><span>備註（選填）</span><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如：用 8 月累積的存款買入" maxLength={100} /></label>

            <div className="purchase-preview">
              <span><ProfileAvatar avatar={profile.avatar} /></span>
              <div><b>這筆記錄完成後</b><small>爸媽銀行會扣除 {money.format(plannedCost)}，同額移到 ETF 小森林；總資產不會憑空增加。</small></div>
            </div>
            <label className="confirm-check">
              <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
              <span>我確認這筆交易已經在真實券商完成</span>
            </label>
            {operationError?.scope === "purchase" && <p className="form-error">{operationError.message}</p>}
            <button className="primary-button full-width" disabled={pinStatus !== "unlocked" || saving || !confirmed || plannedCost <= 0 || plannedCost > profile.bankBalance || Number(units) <= 0}>
              {saving ? "正在記錄與備份…" : `確認記錄 ${profile.name}的買入`}
            </button>
            <small className="parent-save-note">{notice}</small>
          </form>
          </div>
        </details>

        <div className="holding-column">
          <section className="holding-panel">
            <div className="holding-heading"><div><span className="parent-kicker">目前持有</span><h2>{profile.name}的 ETF 小森林</h2></div><b>{holdings.length} 個標的</b></div>
            <div className="market-quote-actions">
              <div className="market-auto-label"><b>自動更新</b><InfoTip align="right">登入家庭或回到網站時，系統會在背景檢查證交所最新可用收盤價；同一家庭 30 分鐘內不會重複請求。這不是盤中即時報價。</InfoTip></div>
              <button type="button" disabled={pinStatus !== "unlocked" || !holdings.length || parentBusy === "market-quotes"} onClick={() => void updateMarketQuotes()}>
                {parentBusy === "market-quotes" ? "檢查中…" : "重新檢查收盤價"}
              </button>
              {(quoteMeta || holdings.some((holding) => holding.priceUpdatedAt)) && <small>
                {quoteMeta?.source ?? "最近行情"} · {new Date(quoteMeta?.updatedAt ?? holdings.find((holding) => holding.priceUpdatedAt)?.priceUpdatedAt ?? "").toLocaleString("zh-TW")}
              </small>}
            </div>
            {holdings.length ? holdings.map((holding) => {
              const gain = holding.marketValue - holding.costBasis;
              const rate = holding.costBasis ? gain / holding.costBasis * 100 : 0;
              return (
                <div className="holding-record" key={holding.id}>
                  <article className="holding-card">
                    <span className="holding-symbol">{holding.symbol}</span>
                    <div><b>{holding.name}</b><small>{holding.category} · {holding.units} 股 · {holding.quoteAsOf ? `${holding.quoteAsOf} 收盤價` : holding.priceUpdatedAt ? `家長更新於 ${new Date(holding.priceUpdatedAt).toLocaleDateString("zh-TW")}` : "尚未更新市值"}</small></div>
                    <div className="holding-value"><b>{money.format(holding.marketValue)}</b><small className={gain >= 0 ? "is-up" : "is-down"}>{gain >= 0 ? "+" : ""}{rate.toFixed(1)}%</small></div>
                  </article>
                  <div className="market-editor"><input type="number" min="0" inputMode="numeric" value={marketValues[holding.id] ?? ""} onChange={(event) => setMarketValues({ ...marketValues, [holding.id]: event.target.value })} placeholder={`更新市值，目前 ${holding.marketValue}`} /><button disabled={pinStatus !== "unlocked" || parentBusy === `market-${holding.id}` || marketValues[holding.id] === undefined || marketValues[holding.id] === ""} onClick={() => void updateMarketValue(holding.id)}>{parentBusy === `market-${holding.id}` ? "更新中…" : "記錄今日市值"}</button></div>
                </div>
              );
            }) : <div className="empty-holding"><span><ProfileAvatar avatar={profile.avatar} /></span><b>第一棵投資小樹還在等你</b><small>等爸媽完成第一次真實買入後，就會出現在這裡。</small></div>}
            <div className="panel-help"><InfoTip align="right">按下更新會取得最新可用收盤價；也可以依券商畫面手動記錄今日市值。</InfoTip></div>
            {operationError?.scope === "holdings" && <p className="form-error">{operationError.message}</p>}
          </section>

          <section className="purchase-history">
            <div className="holding-heading"><div><span className="parent-kicker">最近記錄</span><h2>爸媽協助買入</h2></div></div>
            {purchases.length ? purchases.map((item) => (
              <div className={`purchase-entry${editingPurchaseId === item.id ? " is-editing" : ""}`} key={item.id}>
                <div className="purchase-row">
                  <span>↗</span>
                  <div><b>{item.symbol} · {item.name}</b><small>{item.purchaseDate} · {item.units} 股{item.note ? ` · ${item.note}` : ""}</small></div>
                  <div className="purchase-row-tail">
                    <strong>{money.format(item.totalCost)}</strong>
                    {pinStatus === "unlocked" && <div className="purchase-history-actions">
                      <button type="button" disabled={Boolean(parentBusy)} onClick={() => editingPurchaseId === item.id ? closePurchaseEditor() : editPurchase(item)}>{editingPurchaseId === item.id ? "收起" : "編輯"}</button>
                      <button type="button" className="is-danger" disabled={Boolean(parentBusy)} onClick={() => void voidPurchase(item)}>{parentBusy === `purchase-void-${item.id}` ? "撤銷中…" : "撤銷"}</button>
                    </div>}
                  </div>
                </div>
                {pinStatus === "unlocked" && editingPurchaseId === item.id && <form className="purchase-correction-form" onSubmit={correctPurchase}>
                  <div className="purchase-correction-grid">
                    <label><span>股數</span><input type="number" inputMode="decimal" min="0.0001" step="0.0001" value={editPurchaseUnits} onChange={(event) => setEditPurchaseUnits(event.target.value)} required /></label>
                    <label><span>總成本</span><input type="number" inputMode="numeric" min="1" step="1" value={editPurchaseCost} onChange={(event) => setEditPurchaseCost(event.target.value)} required /></label>
                    <label><span>買入日期</span><input type="date" value={editPurchaseDate} onChange={(event) => setEditPurchaseDate(event.target.value)} required /></label>
                    <label><span>備註</span><input value={editPurchaseNote} onChange={(event) => setEditPurchaseNote(event.target.value)} maxLength={100} placeholder="選填" /></label>
                  </div>
                  <div className="purchase-correction-actions">
                    <button type="button" onClick={closePurchaseEditor}>取消</button>
                    <button type="submit" className="is-primary" disabled={parentBusy === `purchase-correct-${item.id}`}>{parentBusy === `purchase-correct-${item.id}` ? "校正中…" : "儲存更正"}</button>
                  </div>
                </form>}
              </div>
            )) : <p className="empty-history">新記錄會自動留在這裡。</p>}
          </section>

          <details className="harvest-panel" id="harvest">
            <summary className="harvest-summary">
              <div>
                <span className="parent-kicker">一年一次的選擇</span>
                <h2>🧧 過年投資收成日</h2>
                <small>{currentYear} 年最多 {money.format(maxHarvest)} · {harvestedThisYear ? "今年已使用" : "今年尚未使用"}</small>
              </div>
              <span className="harvest-summary-action">
                <b>最多 5%</b>
                <small className="harvest-closed-label">查看或操作 ＋</small>
                <small className="harvest-open-label">收起細節 −</small>
              </span>
            </summary>
            <div className="harvest-content">
              <div className="panel-help"><InfoTip>可以選擇完全不提領。若要使用，爸媽先在券商實際賣出，再把淨入帳金額放回撲滿；短期夢想罐的進度會自動更新。</InfoTip></div>
              <div className="harvest-limit"><span><ProfileAvatar avatar={profile.avatar} /></span><div><small>{currentYear} 年最高收成額度</small><strong>{money.format(maxHarvest)}</strong></div><b>{harvestedThisYear ? "今年已使用" : "今年尚未使用"}</b></div>
              <form onSubmit={submitHarvest}>
                <label>實際賣出的標的<select value={harvestHoldingId} onChange={(event) => setHarvestHoldingId(event.target.value)} required>{holdings.map((holding) => <option key={holding.id} value={holding.id}>{holding.symbol} · {holding.name}（{holding.units} 股）</option>)}</select></label>
                <div className="form-two-columns"><label>實際賣出股數<input type="number" min="0.0001" step="0.0001" value={soldUnits} onChange={(event) => setSoldUnits(event.target.value)} required /></label><label>券商淨入帳<input type="number" min="1" max={maxHarvest} value={netProceeds} onChange={(event) => setNetProceeds(event.target.value)} required /></label></div>
                <label>這次收成要對應哪個短期夢想？<select value={destinationDreamId} onChange={(event) => setDestinationDreamId(event.target.value)}><option value="">不指定（仍放回撲滿）</option>{shortDreams.map((jar) => <option key={jar.id} value={jar.id}>短期夢想罐：{jar.title}</option>)}</select></label>
                <label>實際賣出日期<input type="date" value={saleDate} onChange={(event) => setSaleDate(event.target.value)} required /></label>
                <label>備註（選填）<input value={harvestNote} onChange={(event) => setHarvestNote(event.target.value)} placeholder="例如：今年選擇收成 3%" maxLength={100} /></label>
                <label className="confirm-check"><input type="checkbox" checked={harvestConfirmed} onChange={(event) => setHarvestConfirmed(event.target.checked)} /><span>我確認這筆股票已在真實券商賣出</span></label>
                <button className="primary-button full-width" disabled={pinStatus !== "unlocked" || harvestedThisYear || !holdings.length || !harvestConfirmed || Number(netProceeds) <= 0 || Number(netProceeds) > maxHarvest || Number(soldUnits) <= 0 || parentBusy === "harvest"}>{parentBusy === "harvest" ? "記錄收成中…" : harvestedThisYear ? "今年已完成收成" : "確認過年收成"}</button>
              </form>
              <details className="harvest-history-panel">
                <summary><span>過年收成歷史</span><b>{harvestHistory.length} 筆 ＋</b></summary>
                <div className="harvest-history-list">
                  {harvestHistory.length ? harvestHistory.map((item) => {
                    const holding = state.holdings.find((candidate) => candidate.id === item.holdingId);
                    const destination = state.dreamJars.find((candidate) => candidate.id === item.destinationDreamId);
                    const destinationOptions = destination && !shortDreams.some((candidate) => candidate.id === destination.id)
                      ? [destination, ...shortDreams]
                      : shortDreams;
                    const isEditing = editingHarvestId === item.id;
                    return <article className={`harvest-history-entry${isEditing ? " is-editing" : ""}`} key={item.id}>
                      <div className="harvest-history-row">
                        <span aria-hidden="true">福</span>
                        <div><strong>{item.year} 年 · {money.format(item.netProceeds)}</strong><small>{item.saleDate} · {holding?.symbol ?? "歷史標的"} · {item.soldUnits} 股{destination ? ` · ${destination.title}` : ""}</small></div>
                        {pinStatus === "unlocked" && <div className="harvest-history-actions">
                          <button type="button" disabled={Boolean(parentBusy)} onClick={() => isEditing ? closeHarvestEditor() : editHarvest(item)}>{isEditing ? "收起" : "編輯"}</button>
                          <button type="button" className="is-danger" disabled={Boolean(parentBusy)} onClick={() => void voidHarvest(item)}>{parentBusy === `harvest-void-${item.id}` ? "撤銷中…" : "撤銷"}</button>
                        </div>}
                      </div>
                      {pinStatus === "unlocked" && isEditing && <form className="harvest-correction-form" onSubmit={correctHarvest}>
                        <div className="harvest-correction-grid">
                          <label><span>實際賣出股數</span><input type="number" inputMode="decimal" min="0.0001" step="0.0001" value={editHarvestSoldUnits} onChange={(event) => setEditHarvestSoldUnits(event.target.value)} required /></label>
                          <label><span>券商淨入帳</span><input type="number" inputMode="numeric" min="1" step="1" value={editHarvestNetProceeds} onChange={(event) => setEditHarvestNetProceeds(event.target.value)} required /></label>
                          <label><span>短期夢想罐</span><select value={editHarvestDreamId} onChange={(event) => setEditHarvestDreamId(event.target.value)}><option value="">不指定（仍放回撲滿）</option>{destinationOptions.map((jar) => <option key={jar.id} value={jar.id}>{jar.title}{jar.status !== "active" ? "（已完成或排隊中）" : ""}</option>)}</select></label>
                          <label><span>實際賣出日期</span><input type="date" value={editHarvestSaleDate} onChange={(event) => setEditHarvestSaleDate(event.target.value)} required /></label>
                          <label className="harvest-note-field"><span>備註</span><input value={editHarvestNote} onChange={(event) => setEditHarvestNote(event.target.value)} maxLength={100} placeholder="選填" /></label>
                        </div>
                        <div className="harvest-correction-actions"><button type="button" onClick={closeHarvestEditor}>取消</button><button type="submit" className="is-primary" disabled={parentBusy === `harvest-correct-${item.id}`}>{parentBusy === `harvest-correct-${item.id}` ? "校正中…" : "儲存更正"}</button></div>
                      </form>}
                    </article>;
                  }) : <p className="empty-history">尚未有過年收成紀錄。</p>}
                </div>
              </details>
              {operationError?.scope === "harvest" && <p className="form-error">{operationError.message}</p>}
            </div>
          </details>
        </div>
      </section>
      <DeviceTrustPanel parentPin={parentPin} unlocked={pinStatus === "unlocked"} onDownloadBackup={() => downloadBackup("account")} onDownloadPortableBackup={() => downloadBackup("portable")} onRestore={(next) => { setMoneyStateCache(next); announce("備份已還原，畫面已更新"); }} />
      <StatusToast toast={toast} onDismiss={dismissStatus} />
    </main>
  );
}
