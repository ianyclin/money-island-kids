import { updateInvestmentPreset, withFamilyMutationLock } from "../../../db/money-store";
import { requireFamilySession } from "../family-session";
import { privateJson, rejectUntrustedMutationOrigin } from "../request-security";

export async function POST(request: Request) {
  const originError = rejectUntrustedMutationOrigin(request);
  if (originError) return originError;
  try {
    const session = await requireFamilySession(request);
    const body = await request.json() as {
      action?: "create" | "update" | "delete";
      presetId?: string;
      symbol?: string;
      name?: string;
      category?: "ETF" | "股票";
      sortOrder?: number;
      parentPin?: string;
    };
    if (!body.action) return privateJson({ error: "缺少常用標的操作" }, { status: 400 });
    return privateJson(await withFamilyMutationLock(session.familyId, () => updateInvestmentPreset({ ...body, familyId: session.familyId } as Parameters<typeof updateInvestmentPreset>[0])));
  } catch (error) {
    const message = error instanceof Error ? error.message : "常用標的調整失敗";
    return privateJson({ error: message }, { status: message.includes("登入家庭") ? 401 : 400 });
  }
}
