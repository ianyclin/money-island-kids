import { resolveFamilySession, type FamilySession } from "../../db/money-store";

export const DEVICE_COOKIE_NAME = "money_island_device";
export const DEVICE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 10;

export function readCookie(request: Request, name: string): string | null {
  const cookies = request.headers.get("cookie") ?? "";
  for (const part of cookies.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

export async function requireFamilySession(request: Request): Promise<FamilySession> {
  const session = await resolveFamilySession(readCookie(request, DEVICE_COOKIE_NAME));
  if (!session) throw new Error("請先建立家庭或登入家庭帳本");
  return session;
}
