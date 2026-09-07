import { env } from "cloudflare:workers";
import { LEGACY_FAMILY_ID } from "../../../db/money-store";
import { requireFamilySession } from "../family-session";
import { privateResponseHeaders } from "../request-security";

export async function GET(request: Request) {
  const session = await requireFamilySession(request).catch(() => null);
  if (!session) return new Response("Unauthorized", { status: 401, headers: privateResponseHeaders() });
  const profileId = new URL(request.url).searchParams.get("profileId") ?? "";
  if (!/^[a-z0-9-]{2,40}$/.test(profileId) || !env.PROFILE_PHOTOS) {
    return new Response("Not found", { status: 404, headers: privateResponseHeaders() });
  }
  const photo = await env.PROFILE_PHOTOS.get(`profile-photos/${session.familyId}/${profileId}`)
    ?? (session.familyId === LEGACY_FAMILY_ID ? await env.PROFILE_PHOTOS.get(`profile-photos/${profileId}`) : null);
  if (!photo) return new Response("Not found", { status: 404, headers: privateResponseHeaders() });
  return new Response(photo.body, {
    headers: privateResponseHeaders({
      "content-type": photo.httpMetadata?.contentType ?? "image/jpeg",
      "content-disposition": "inline",
      "x-content-type-options": "nosniff",
    }),
  });
}
