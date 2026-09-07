import { updateGardenSpecies, withFamilyMutationLock } from "../../../db/money-store";
import type { GardenSpecies } from "../../money-types";
import { requireFamilySession } from "../family-session";
import { privateJson, rejectUntrustedMutationOrigin } from "../request-security";

export async function POST(request: Request) {
  const originError = rejectUntrustedMutationOrigin(request);
  if (originError) return originError;
  try {
    const session = await requireFamilySession(request);
    const body = await request.json() as { profileId?: string; gardenSpecies?: GardenSpecies };
    if (!body.profileId || !body.gardenSpecies) {
      return privateJson({ error: "請先選擇樹種或花種" }, { status: 400 });
    }
    return privateJson(await withFamilyMutationLock(session.familyId, () => updateGardenSpecies({
      familyId: session.familyId,
      profileId: body.profileId!,
      gardenSpecies: body.gardenSpecies!,
    })));
  } catch (error) {
    const message = error instanceof Error ? error.message : "花園設定失敗";
    return privateJson({ error: message }, { status: message.includes("登入家庭") ? 401 : 400 });
  }
}
