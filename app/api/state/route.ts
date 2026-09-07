import { ensureMonthlySavingsRewards, getMoneyState } from "../../../db/money-store";
import { requireFamilySession } from "../family-session";
import { privateJson } from "../request-security";

export async function GET(request: Request) {
  try {
    const session = await requireFamilySession(request);
    await ensureMonthlySavingsRewards(session.familyId);
    return privateJson(await getMoneyState(session.familyId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "讀取資料失敗";
    return privateJson({ error: message }, { status: message.includes("登入家庭") ? 401 : 500 });
  }
}
