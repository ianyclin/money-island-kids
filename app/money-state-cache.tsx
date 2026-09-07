"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { KidProfile, MoneyState } from "./money-types";

type MoneySnapshot = {
  state: MoneyState | null;
  error: string;
  loading: boolean;
  revalidating: boolean;
};

const EMPTY_SNAPSHOT: MoneySnapshot = { state: null, error: "", loading: true, revalidating: false };
let snapshot: MoneySnapshot = EMPTY_SNAPSHOT;
let inFlight: Promise<MoneyState> | null = null;
let automaticQuoteInFlight: Promise<void> | null = null;
let cacheGeneration = 0;
let lastFetchedAt = 0;
let lastAutomaticQuoteAttemptAt = 0;
const listeners = new Set<() => void>();
const STATE_REVALIDATE_AFTER_MS = 30_000;
const AUTO_QUOTE_RETRY_AFTER_MS = 30 * 60_000;
const AUTO_QUOTE_STORAGE_KEY_PREFIX = "money-island-auto-quote";

function publish(next: MoneySnapshot) {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function responseError(result: unknown, fallback: string): string {
  if (result && typeof result === "object" && "error" in result && typeof result.error === "string") return result.error;
  return fallback;
}

export async function revalidateMoneyState(): Promise<MoneyState> {
  if (inFlight) return inFlight;
  const requestGeneration = cacheGeneration;
  publish({ ...snapshot, loading: !snapshot.state, revalidating: Boolean(snapshot.state), error: "" });
  const request = fetch("/api/state", { cache: "no-store" })
    .then(async (response) => {
      const result = await response.json().catch(() => null) as MoneyState | { error?: string } | null;
      if (requestGeneration !== cacheGeneration) throw new Error("家庭帳本已切換");
      if (response.status === 401) {
        clearMoneyStateCache();
        if (typeof window !== "undefined") window.location.replace("/family-access");
        throw new Error(responseError(result, "請先登入家庭"));
      }
      if (!response.ok || !result || !("profiles" in result) || !Array.isArray(result.profiles)) {
        throw new Error(responseError(result, "暫時無法讀取家庭帳本"));
      }
      lastFetchedAt = Date.now();
      publish({ state: result, error: "", loading: false, revalidating: false });
      void refreshAutomaticMarketQuotes(requestGeneration, result);
      return result;
    })
    .catch((caught) => {
      const message = caught instanceof Error ? caught.message : "暫時無法讀取家庭帳本";
      if (requestGeneration === cacheGeneration) publish({ ...snapshot, error: message, loading: false, revalidating: false });
      throw caught;
    })
    .finally(() => {
      if (inFlight === request) inFlight = null;
    });
  inFlight = request;
  return request;
}

export function setMoneyStateCache(state: MoneyState) {
  cacheGeneration += 1;
  inFlight = null;
  lastFetchedAt = Date.now();
  publish({ state, error: "", loading: false, revalidating: false });
}

export function clearMoneyStateCache() {
  cacheGeneration += 1;
  inFlight = null;
  automaticQuoteInFlight = null;
  lastFetchedAt = 0;
  lastAutomaticQuoteAttemptAt = 0;
  publish(EMPTY_SNAPSHOT);
}

export function useMoneyStateCache() {
  const current = useSyncExternalStore(subscribe, () => snapshot, () => EMPTY_SNAPSHOT);
  useEffect(() => {
    const refreshIfStale = () => {
      if (!snapshot.state || Date.now() - lastFetchedAt >= STATE_REVALIDATE_AFTER_MS) {
        void revalidateMoneyState().catch(() => undefined);
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") refreshIfStale();
    };
    refreshIfStale();
    window.addEventListener("focus", refreshIfStale);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", refreshIfStale);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  return current;
}

async function refreshAutomaticMarketQuotes(requestGeneration: number, state: MoneyState): Promise<void> {
  const hasSupportedHolding = state.holdings.some((holding) =>
    holding.currency.toUpperCase() === "TWD" && /^\d{4,6}$/.test(holding.symbol.trim()),
  );
  const storageKey = `${AUTO_QUOTE_STORAGE_KEY_PREFIX}:${state.family?.id ?? "current"}`;
  let storedAttemptAt = 0;
  try {
    storedAttemptAt = Number(window.localStorage.getItem(storageKey)) || 0;
  } catch {
    // Some privacy modes disable local storage; the in-memory guard still applies.
  }
  const mostRecentAttemptAt = Math.max(lastAutomaticQuoteAttemptAt, storedAttemptAt);
  if (!hasSupportedHolding || automaticQuoteInFlight || Date.now() - mostRecentAttemptAt < AUTO_QUOTE_RETRY_AFTER_MS) return;

  lastAutomaticQuoteAttemptAt = Date.now();
  try {
    window.localStorage.setItem(storageKey, String(lastAutomaticQuoteAttemptAt));
  } catch {
    // The quote refresh can safely continue without local storage.
  }
  const request = fetch("/api/market-quotes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "auto" }),
  })
    .then(async (response) => {
      const result = await response.json().catch(() => null) as ({ state?: MoneyState } & Partial<MoneyState> & { error?: string }) | null;
      if (!response.ok || !result || requestGeneration !== cacheGeneration) return;
      const nextState = result.state ?? (Array.isArray(result.profiles) ? result as MoneyState : null);
      if (nextState) {
        lastFetchedAt = Date.now();
        publish({ state: nextState, error: "", loading: false, revalidating: false });
      }
    })
    .catch(() => undefined)
    .finally(() => {
      if (automaticQuoteInFlight === request) automaticQuoteInFlight = null;
    });
  automaticQuoteInFlight = request;
  await request;
}

const PROFILE_STORAGE_KEY = "money-island-profile";
const PROFILE_CHANGE_EVENT = "money-island-profile-change";

function readStoredProfileId(): string {
  return typeof window === "undefined" ? "" : window.localStorage.getItem(PROFILE_STORAGE_KEY) ?? "";
}

function subscribeProfile(listener: () => void) {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === PROFILE_STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(PROFILE_CHANGE_EVENT, listener);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(PROFILE_CHANGE_EVENT, listener);
  };
}

export function useSelectedProfile(profiles: KidProfile[]): {
  profile: KidProfile | null;
  selectedId: string;
  chooseProfile: (id: string) => void;
} {
  const storedId = useSyncExternalStore(subscribeProfile, readStoredProfileId, () => "");
  const profile = profiles.find((item) => item.id === storedId) ?? profiles[0] ?? null;
  const chooseProfile = useCallback((id: string) => {
    if (!profiles.some((item) => item.id === id)) return;
    window.localStorage.setItem(PROFILE_STORAGE_KEY, id);
    window.dispatchEvent(new Event(PROFILE_CHANGE_EVENT));
  }, [profiles]);
  return { profile, selectedId: profile?.id ?? "", chooseProfile };
}

export function moneyThemeStyle(profile: KidProfile | null): React.CSSProperties {
  return profile ? ({ "--kid-accent": profile.accent } as React.CSSProperties) : {};
}

export function MoneyStateGate({ error, onRetry }: { error?: string; onRetry?: () => void }) {
  return (
    <main className="money-state-gate" aria-live="polite">
      <div className="money-state-gate-card">
        <span className="brand-mark" aria-hidden="true">¢</span>
        {error ? (
          <>
            <h1>暫時讀不到家庭帳本</h1>
            <p>{error}</p>
            <button type="button" onClick={onRetry}>再試一次</button>
          </>
        ) : (
          <>
            <div className="state-skeleton state-skeleton-title" />
            <div className="state-skeleton" />
            <div className="state-skeleton state-skeleton-short" />
            <span className="sr-only">正在讀取家庭帳本</span>
          </>
        )}
      </div>
    </main>
  );
}
