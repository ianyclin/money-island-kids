import { correctAnnualHarvest, recordAnnualHarvest, voidAnnualHarvest, withFamilyMutationLock } from "../../../db/money-store";
import { requireFamilySession } from "../family-session";
import { privateJson, rejectUntrustedMutationOrigin } from "../request-security";

export async function POST(request: Request) {
  const originError = rejectUntrustedMutationOrigin(request);
  if (originError) return originError;
  try {
    const session = await requireFamilySession(request);
    const body = await request.json() as {
      action?: "record" | "correct" | "void";
      harvestId?: string;
      profileId?: string;
      holdingId?: string;
      soldUnits?: number;
      netProceeds?: number;
      destinationDreamId?: string | null;
      saleDate?: string;
      note?: string;
      parentPin?: string;
    };
    if (body.action === "void") {
      if (!body.harvestId) return privateJson({ error: "找不到這筆過年收成" }, { status: 400 });
      return privateJson(await withFamilyMutationLock(session.familyId, () => voidAnnualHarvest({
        familyId: session.familyId,
        harvestId: body.harvestId!,
        parentPin: body.parentPin,
      })));
    }
    if (body.action === "correct") {
      if (!body.harvestId) return privateJson({ error: "找不到這筆過年收成" }, { status: 400 });
      return privateJson(await withFamilyMutationLock(session.familyId, () => correctAnnualHarvest({
        familyId: session.familyId,
        harvestId: body.harvestId!,
        soldUnits: Number(body.soldUnits),
        netProceeds: Number(body.netProceeds),
        destinationDreamId: body.destinationDreamId,
        saleDate: body.saleDate,
        note: body.note,
        parentPin: body.parentPin,
      })));
    }
    if (!body.profileId || !body.holdingId) return privateJson({ error: "請填完整收成資料" }, { status: 400 });
    return privateJson(await withFamilyMutationLock(session.familyId, () => recordAnnualHarvest({
      familyId: session.familyId,
      profileId: body.profileId!,
      holdingId: body.holdingId!,
      soldUnits: Number(body.soldUnits),
      netProceeds: Number(body.netProceeds),
      destinationDreamId: body.destinationDreamId,
      saleDate: body.saleDate,
      note: body.note,
      parentPin: body.parentPin,
    })));
  } catch (error) {
    const message = error instanceof Error ? error.message : "過年收成儲存失敗";
    return privateJson({ error: message }, { status: message.includes("登入家庭") ? 401 : 400 });
  }
}
