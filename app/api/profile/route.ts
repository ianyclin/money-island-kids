import { env } from "cloudflare:workers";
import { assertParentPin, updateProfile } from "../../../db/money-store";
import { requireFamilySession } from "../family-session";
import { privateJson, rejectUntrustedMutationOrigin } from "../request-security";

const ALLOWED_PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

export async function POST(request: Request) {
  const originError = rejectUntrustedMutationOrigin(request);
  if (originError) return originError;
  try {
    const session = await requireFamilySession(request);
    const form = await request.formData();
    const profileId = String(form.get("profileId") ?? "");
    const name = String(form.get("name") ?? "");
    const parentPin = String(form.get("parentPin") ?? "");
    const photo = form.get("photo");
    if (!/^[a-z0-9-]{2,40}$/.test(profileId)) {
      return privateJson({ error: "請先選擇小朋友" }, { status: 400 });
    }
    if (!name.trim() || Array.from(name.trim()).length > 12) throw new Error("名字請輸入 1 到 12 個字");
    await assertParentPin(session.familyId, parentPin);

    let avatar: string | undefined;
    if (photo instanceof File && photo.size > 0) {
      if (!ALLOWED_PHOTO_TYPES.has(photo.type)) throw new Error("照片請使用 JPG、PNG 或 WebP 格式");
      if (photo.size > MAX_PHOTO_BYTES) throw new Error("照片請小於 4 MB");
      if (!env.PROFILE_PHOTOS) throw new Error("照片儲存空間尚未連線");
      await env.PROFILE_PHOTOS.put(`profile-photos/${session.familyId}/${profileId}`, photo.stream(), {
        httpMetadata: { contentType: photo.type, cacheControl: "private, no-store, max-age=0" },
      });
      avatar = `/api/profile-photo?profileId=${encodeURIComponent(profileId)}&v=${Date.now()}`;
    }

    return privateJson(await updateProfile({ familyId: session.familyId, profileId, name, avatar, parentPin }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "名字或照片儲存失敗";
    return privateJson({ error: message }, { status: 400 });
  }
}
