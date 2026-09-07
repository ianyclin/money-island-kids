import { updateSavingsTransfer, withFamilyMutationLock } from "../../../db/money-store";
import type { SavingsTransferAction } from "../../money-types";
import { requireFamilySession } from "../family-session";
import { privateJson, rejectUntrustedMutationOrigin } from "../request-security";

export async function POST(request: Request) {
  const originError = rejectUntrustedMutationOrigin(request);
  if (originError) return originError;
  try {
    const session = await requireFamilySession(request);
    const body = await request.json() as {
      action?: SavingsTransferAction;
      transferId?: string;
      profileId?: string;
      amount?: number;
      note?: string;
      operationId?: string;
      parentPin?: string;
    };
    if (!body.action) return privateJson({ error: "缺少必要資料" }, { status: 400 });
    return privateJson(await withFamilyMutationLock(session.familyId, () => updateSavingsTransfer({
      familyId: session.familyId,
      action: body.action!,
      transferId: body.transferId,
      profileId: body.profileId,
      amount: body.amount,
      note: body.note,
      operationId: body.operationId,
      parentPin: body.parentPin,
    })));
  } catch (error) {
    const message = error instanceof Error ? error.message : "自主存錢儲存失敗";
    return privateJson({ error: message }, { status: message.includes("登入家庭") ? 401 : 400 });
  }
}
