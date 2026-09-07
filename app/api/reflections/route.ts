import { saveMonthlyReflection, withFamilyMutationLock } from "../../../db/money-store";
import { requireFamilySession } from "../family-session";
import { privateJson, rejectUntrustedMutationOrigin } from "../request-security";

export async function POST(request: Request) {
  const originError = rejectUntrustedMutationOrigin(request);
  if (originError) return originError;
  try {
    const session = await requireFamilySession(request);
    const body = await request.json() as {
      profileId?: string;
      month?: string;
      proudText?: string;
      changeText?: string;
      planText?: string;
    };
    if (!body.profileId) return privateJson({ error: "請先選擇小朋友" }, { status: 400 });
    return privateJson(await withFamilyMutationLock(session.familyId, () => saveMonthlyReflection({ ...body, familyId: session.familyId } as Parameters<typeof saveMonthlyReflection>[0])));
  } catch (error) {
    const message = error instanceof Error ? error.message : "每月回顧儲存失敗";
    return privateJson({ error: message }, { status: message.includes("登入家庭") ? 401 : 400 });
  }
}
