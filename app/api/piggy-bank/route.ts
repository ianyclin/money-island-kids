import { setPiggyBankBalance, withFamilyMutationLock } from "../../../db/money-store";
import { requireFamilySession } from "../family-session";
import { privateJson, rejectUntrustedMutationOrigin } from "../request-security";

export async function POST(request: Request) {
  const originError = rejectUntrustedMutationOrigin(request);
  if (originError) return originError;
  try {
    const session = await requireFamilySession(request);
    const body = await request.json() as { profileId?: string; balance?: number; note?: string; parentPin?: string };
    if (!body.profileId) return privateJson({ error: "缺少小朋友資料" }, { status: 400 });
    return privateJson(await withFamilyMutationLock(session.familyId, () => setPiggyBankBalance({
      familyId: session.familyId,
      profileId: body.profileId!,
      balance: Number(body.balance),
      note: body.note,
      parentPin: body.parentPin,
    })));
  } catch (error) {
    const message = error instanceof Error ? error.message : "撲滿金額儲存失敗";
    return privateJson({ error: message }, { status: message.includes("登入家庭") ? 401 : 400 });
  }
}
