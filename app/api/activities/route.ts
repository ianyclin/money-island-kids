import { getActivitiesPage, updateActivityRecord, withFamilyMutationLock } from "../../../db/money-store";
import { requireFamilySession } from "../family-session";
import { privateJson, rejectUntrustedMutationOrigin } from "../request-security";

export async function GET(request: Request) {
  try {
    const session = await requireFamilySession(request);
    const url = new URL(request.url);
    const profileId = url.searchParams.get("profileId") ?? "";
    if (!profileId) return privateJson({ error: "請先選擇小朋友" }, { status: 400 });
    return privateJson(await getActivitiesPage({
      familyId: session.familyId,
      profileId,
      query: url.searchParams.get("query") ?? "",
      kind: url.searchParams.get("kind") ?? "all",
      offset: Number(url.searchParams.get("offset") ?? 0),
      limit: Number(url.searchParams.get("limit") ?? 40),
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "讀取紀錄失敗";
    return privateJson({ error: message }, { status: message.includes("登入家庭") ? 401 : 400 });
  }
}

export async function POST(request: Request) {
  const originError = rejectUntrustedMutationOrigin(request);
  if (originError) return originError;
  try {
    const session = await requireFamilySession(request);
    const body = await request.json() as {
      action?: "edit" | "delete";
      activityId?: string;
      label?: string;
      note?: string;
      entryDate?: string;
      parentPin?: string;
    };
    if (!body.action || !body.activityId) return privateJson({ error: "找不到這筆紀錄" }, { status: 400 });
    return privateJson(await withFamilyMutationLock(session.familyId, () => updateActivityRecord({ ...body, familyId: session.familyId } as Parameters<typeof updateActivityRecord>[0])));
  } catch (error) {
    const message = error instanceof Error ? error.message : "紀錄調整失敗";
    return privateJson({ error: message }, { status: message.includes("登入家庭") ? 401 : 400 });
  }
}
