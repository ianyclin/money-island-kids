import { updateHoldingMarketValue, withFamilyMutationLock } from "../../../db/money-store";
import { requireFamilySession } from "../family-session";
import { privateJson, rejectUntrustedMutationOrigin } from "../request-security";

export async function POST(request: Request) {
  const originError = rejectUntrustedMutationOrigin(request);
  if (originError) return originError;
  try {
    const session = await requireFamilySession(request);
    const body = await request.json() as { holdingId?: string; marketValue?: number; parentPin?: string };
    if (!body.holdingId) return privateJson({ error: "找不到投資標的" }, { status: 400 });
    return privateJson(await withFamilyMutationLock(session.familyId, () => updateHoldingMarketValue({
      familyId: session.familyId,
      holdingId: body.holdingId!,
      marketValue: Number(body.marketValue),
      parentPin: body.parentPin,
    })));
  } catch (error) {
    const message = error instanceof Error ? error.message : "市值更新失敗";
    return privateJson({ error: message }, { status: message.includes("登入家庭") ? 401 : 400 });
  }
}
