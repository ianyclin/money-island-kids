import { updateFamilyProject, withFamilyMutationLock } from "../../../db/money-store";
import type { ProjectAction } from "../../money-types";
import { requireFamilySession } from "../family-session";
import { privateJson, rejectUntrustedMutationOrigin } from "../request-security";

export async function POST(request: Request) {
  const originError = rejectUntrustedMutationOrigin(request);
  if (originError) return originError;
  try {
    const session = await requireFamilySession(request);
    const body = await request.json() as {
      action?: ProjectAction;
      projectId?: string;
      profileId?: string;
      title?: string;
      description?: string;
      reward?: number;
      parentPin?: string;
    };
    if (!body.action) return privateJson({ error: "缺少必要資料" }, { status: 400 });
    return privateJson(await withFamilyMutationLock(session.familyId, () => updateFamilyProject({
      familyId: session.familyId,
      action: body.action!,
      projectId: body.projectId,
      profileId: body.profileId,
      title: body.title,
      description: body.description,
      reward: body.reward,
      parentPin: body.parentPin,
    })));
  } catch (error) {
    const message = error instanceof Error ? error.message : "儲存失敗";
    return privateJson({ error: message }, { status: message.includes("登入家庭") ? 401 : 400 });
  }
}
