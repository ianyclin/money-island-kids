import { assertParentPin, changeParentPin, getParentPinStatus, setParentPin } from "../../../db/money-store";
import { requireFamilySession } from "../family-session";
import { privateJson, rejectUntrustedMutationOrigin } from "../request-security";

export async function GET(request: Request) {
  try {
    const session = await requireFamilySession(request);
    return privateJson(await getParentPinStatus(session.familyId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "讀取操作碼狀態失敗";
    return privateJson({ error: message }, { status: message.includes("登入家庭") ? 401 : 500 });
  }
}

export async function POST(request: Request) {
  const originError = rejectUntrustedMutationOrigin(request);
  if (originError) return originError;
  try {
    const session = await requireFamilySession(request);
    const body = await request.json() as { action?: "setup" | "verify" | "change"; pin?: string; newPin?: string };
    if (!body.pin || !body.action) return privateJson({ error: "請輸入家長操作碼" }, { status: 400 });
    if (body.action === "setup") await setParentPin(session.familyId, body.pin);
    else if (body.action === "change") {
      if (!body.newPin) return privateJson({ error: "請輸入新的家長操作碼" }, { status: 400 });
      await changeParentPin(session.familyId, body.pin, body.newPin);
    } else await assertParentPin(session.familyId, body.pin);
    return privateJson({ ok: true, configured: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "操作碼驗證失敗";
    return privateJson(
      { error: message },
      { status: message.includes("15 分鐘") ? 429 : 400, headers: message.includes("15 分鐘") ? { "retry-after": "900" } : undefined },
    );
  }
}
