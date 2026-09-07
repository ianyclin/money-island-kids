import { refreshTwseClosingPrices, withFamilyMutationLock } from "../../../db/money-store";
import { requireFamilySession } from "../family-session";
import { privateJson, rejectUntrustedMutationOrigin } from "../request-security";

export async function POST(request: Request) {
  const originError = rejectUntrustedMutationOrigin(request);
  if (originError) return originError;
  try {
    const session = await requireFamilySession(request);
    const body = await request.json().catch(() => ({})) as {
      profileId?: string;
      mode?: "auto" | "parent";
      parentPin?: string;
    };
    const state = await withFamilyMutationLock(session.familyId, () => refreshTwseClosingPrices({
      familyId: session.familyId,
      profileId: body.profileId?.trim() || undefined,
      mode: body.mode === "auto" ? "auto" : "parent",
      parentPin: body.parentPin,
    }));
    return privateJson({
      state,
      updatedAt: state.quoteRefresh?.fetchedAt ?? new Date().toISOString(),
      source: state.quoteRefresh?.source ?? "臺灣證券交易所最新收盤價",
      updatedSymbols: state.quoteRefresh?.updatedSymbols ?? [],
      unavailableSymbols: state.quoteRefresh?.unavailableSymbols ?? [],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "最新收盤價更新失敗";
    return privateJson({ error: message }, { status: message.includes("登入家庭") ? 401 : 400 });
  }
}
