import { updateSavingsRate, withFamilyMutationLock } from "../../../db/money-store";
import { requireFamilySession } from "../family-session";
import { privateJson, rejectUntrustedMutationOrigin } from "../request-security";

export async function POST(request: Request) {
  const originError = rejectUntrustedMutationOrigin(request);
  if (originError) return originError;
  try {
    const session = await requireFamilySession(request);
    const body = await request.json() as { savingsRate?: number; parentPin?: string };
    return privateJson(await withFamilyMutationLock(session.familyId, () => updateSavingsRate({ ...body, familyId: session.familyId })));
  } catch (error) {
    return privateJson(
      { error: error instanceof Error ? error.message : "設定儲存失敗" },
      { status: error instanceof Error && error.message.includes("登入家庭") ? 401 : 400 },
    );
  }
}
