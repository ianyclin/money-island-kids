import {
  createBackupEnvelope,
  createPortableBackupEnvelope,
  inspectBackupEnvelope,
  restoreBackupEnvelope,
  restorePortableBackupEnvelope,
  withFamilyMutationLock,
} from "../../../db/money-store";
import { requireFamilySession } from "../family-session";
import { privateJson, rejectUntrustedMutationOrigin } from "../request-security";

const MAX_BACKUP_BYTES = 24 * 1024 * 1024;

export async function POST(request: Request) {
  const originError = rejectUntrustedMutationOrigin(request);
  if (originError) return originError;
  try {
    const session = await requireFamilySession(request);
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = await request.json() as { action?: "export" | "export-portable"; parentPin?: string };
      if (body.action === "export") return privateJson(await createBackupEnvelope(session.familyId, body.parentPin));
      if (body.action === "export-portable") return privateJson(await createPortableBackupEnvelope(session.familyId, body.parentPin));
      return privateJson({ error: "不支援的備份操作" }, { status: 400 });
    }
    const form = await request.formData();
    const action = String(form.get("action") ?? "inspect");
    const parentPin = String(form.get("parentPin") ?? "");
    const file = form.get("file");
    if (!(file instanceof File) || !file.size) throw new Error("請選擇 JSON 備份檔");
    if (file.size > MAX_BACKUP_BYTES) throw new Error("備份檔請小於 24 MB");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      throw new Error("檔案不是有效的 JSON 格式");
    }
    const summary = inspectBackupEnvelope(parsed);
    if (!summary.portable && summary.family.id !== session.familyId) throw new Error("這份帳本備份屬於另一個家庭；請改用完整可攜備份");
    if (action === "inspect") return privateJson({ ok: true, summary });
    if (action !== "restore" || form.get("confirm") !== "RESTORE") throw new Error("請先確認要覆蓋目前帳本");
    return privateJson({
      ok: true,
      state: await withFamilyMutationLock(session.familyId, () => summary.portable
        ? restorePortableBackupEnvelope(session.familyId, parentPin, parsed)
        : restoreBackupEnvelope(session.familyId, parentPin, parsed)),
    });
  } catch (error) {
    return privateJson({ error: error instanceof Error ? error.message : "備份操作失敗" }, { status: 400 });
  }
}
