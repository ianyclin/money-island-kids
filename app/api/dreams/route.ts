import { updateDreamJar, withFamilyMutationLock } from "../../../db/money-store";
import type { DreamAction } from "../../money-types";
import { requireFamilySession } from "../family-session";
import { privateJson, rejectUntrustedMutationOrigin } from "../request-security";

export async function POST(request: Request) {
  const originError = rejectUntrustedMutationOrigin(request);
  if (originError) return originError;
  try {
    const session = await requireFamilySession(request);
    const body = await request.json() as {
      action?: DreamAction;
      profileId?: string;
      dreamId?: string;
      title?: string;
      kind?: "short" | "long";
      targetAmount?: number;
      completedAmount?: number;
      createdAt?: string;
      completedAt?: string;
      parentPin?: string;
    };
    if (!body.action || !body.profileId) return privateJson({ error: "缺少夢想罐資料" }, { status: 400 });
    return privateJson(await withFamilyMutationLock(session.familyId, () => updateDreamJar({
      familyId: session.familyId,
      action: body.action!,
      profileId: body.profileId!,
      dreamId: body.dreamId,
      title: body.title,
      kind: body.kind,
      targetAmount: body.targetAmount,
      completedAmount: body.completedAmount,
      createdAt: body.createdAt,
      completedAt: body.completedAt,
      parentPin: body.parentPin,
    })));
  } catch (error) {
    const message = error instanceof Error ? error.message : "夢想罐儲存失敗";
    return privateJson({ error: message }, { status: message.includes("登入家庭") ? 401 : 400 });
  }
}
