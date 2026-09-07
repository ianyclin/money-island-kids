import { addInvestmentPurchase, correctInvestmentPurchase, voidInvestmentPurchase, withFamilyMutationLock } from "../../../db/money-store";
import { requireFamilySession } from "../family-session";
import { privateJson, rejectUntrustedMutationOrigin } from "../request-security";

export async function POST(request: Request) {
  const originError = rejectUntrustedMutationOrigin(request);
  if (originError) return originError;
  try {
    const session = await requireFamilySession(request);
    const body = await request.json() as {
      action?: "purchase" | "correct" | "void";
      purchaseId?: string;
      profileId?: string;
      symbol?: string;
      name?: string;
      category?: "ETF" | "股票";
      units?: number;
      totalCost?: number;
      purchaseDate?: string;
      note?: string;
      operationId?: string;
      parentPin?: string;
    };
    if (body.action === "void") {
      if (!body.purchaseId) return privateJson({ error: "找不到這筆買入紀錄" }, { status: 400 });
      return privateJson(await withFamilyMutationLock(session.familyId, () => voidInvestmentPurchase({
        familyId: session.familyId,
        purchaseId: body.purchaseId!,
        parentPin: body.parentPin,
      })));
    }
    if (body.action === "correct") {
      if (!body.purchaseId) return privateJson({ error: "找不到這筆買入紀錄" }, { status: 400 });
      return privateJson(await withFamilyMutationLock(session.familyId, () => correctInvestmentPurchase({
        familyId: session.familyId,
        purchaseId: body.purchaseId!,
        units: Number(body.units),
        totalCost: Number(body.totalCost),
        purchaseDate: body.purchaseDate,
        note: body.note,
        parentPin: body.parentPin,
      })));
    }
    if (!body.profileId || !body.symbol || !body.name || !body.category) {
      return privateJson({ error: "請填完整買入資料" }, { status: 400 });
    }
    const state = await withFamilyMutationLock(session.familyId, () => addInvestmentPurchase({
      familyId: session.familyId,
      profileId: body.profileId!,
      symbol: body.symbol!,
      name: body.name!,
      category: body.category!,
      units: Number(body.units),
      totalCost: Number(body.totalCost),
      purchaseDate: body.purchaseDate,
      note: body.note,
      operationId: body.operationId,
      parentPin: body.parentPin,
    }));
    return privateJson(state);
  } catch (error) {
    const message = error instanceof Error ? error.message : "買入紀錄儲存失敗";
    return privateJson({ error: message }, { status: message.includes("登入家庭") ? 401 : 400 });
  }
}
