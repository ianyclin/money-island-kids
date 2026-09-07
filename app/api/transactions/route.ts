import { addTransaction, withFamilyMutationLock } from "../../../db/money-store";
import type { TransactionKind } from "../../money-types";
import { requireFamilySession } from "../family-session";
import { privateJson, rejectUntrustedMutationOrigin } from "../request-security";

export async function POST(request: Request) {
  const originError = rejectUntrustedMutationOrigin(request);
  if (originError) return originError;
  try {
    const session = await requireFamilySession(request);
    const body = await request.json() as {
      profileId?: string;
      kind?: TransactionKind;
      amount?: number;
      label?: string;
      note?: string;
      operationId?: string;
      parentPin?: string;
    };
    if (!body.profileId || !body.kind) {
      return privateJson({ error: "缺少必要資料" }, { status: 400 });
    }
    const state = await withFamilyMutationLock(session.familyId, () => addTransaction({
      familyId: session.familyId,
      profileId: body.profileId!,
      kind: body.kind!,
      amount: body.amount,
      label: body.label,
      note: body.note,
      operationId: body.operationId,
      parentPin: body.parentPin,
    }));
    return privateJson(state);
  } catch (error) {
    const message = error instanceof Error ? error.message : "儲存失敗";
    return privateJson({ error: message }, { status: message.includes("登入家庭") ? 401 : 400 });
  }
}
