import { NextResponse } from "next/server";
import {
  configureExistingFamilyAccount,
  claimLegacyFamilyAccount,
  createFamilyAccount,
  getDeviceAccessStatus,
  listTrustedDevices,
  legacyFamilyNeedsClaim,
  loginFamily,
  recoverFamilyPassword,
  recoverFamilyWithSecurityAnswers,
  revokeTrustedDevice,
  revokeTrustedDeviceByToken,
  resolveFamilySession,
} from "../../../db/money-store";
import { DEVICE_COOKIE_MAX_AGE, DEVICE_COOKIE_NAME, readCookie } from "../family-session";
import { applyPrivateResponseHeaders, privateJson, rejectUntrustedMutationOrigin } from "../request-security";

function withTrustedCookie(request: Request, payload: unknown, token: string): NextResponse {
  const response = NextResponse.json(payload);
  applyPrivateResponseHeaders(response);
  response.cookies.set(DEVICE_COOKIE_NAME, token, {
    httpOnly: true,
    secure: new URL(request.url).protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: DEVICE_COOKIE_MAX_AGE,
  });
  return response;
}

export async function GET(request: Request) {
  try {
    const status = await getDeviceAccessStatus(readCookie(request, DEVICE_COOKIE_NAME));
    return privateJson({ ...status, legacyClaimAvailable: !status.trusted && await legacyFamilyNeedsClaim() });
  } catch (error) {
    return privateJson(
      { error: error instanceof Error ? error.message : "讀取裝置信任狀態失敗" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const originError = rejectUntrustedMutationOrigin(request);
  if (originError) return originError;
  try {
    const body = await request.json() as {
      action?: "claim-existing" | "create-family" | "login" | "configure-existing" | "recover" | "recover-with-answers" | "list" | "revoke" | "logout";
      familyName?: string;
      familyCode?: string;
      password?: string;
      recoveryCode?: string;
      newPassword?: string;
      parentPin?: string;
      profileNames?: string[];
      deviceLabel?: string;
      deviceId?: string;
    };
    if (body.action === "claim-existing") {
      const result = await claimLegacyFamilyAccount({
        familyName: body.familyName ?? "",
        password: body.password ?? "",
        parentPin: body.parentPin,
        deviceLabel: body.deviceLabel,
      });
      const { token, ...safeResult } = result;
      return withTrustedCookie(request, { ok: true, trusted: true, ...safeResult }, token);
    }
    if (body.action === "create-family") {
      const result = await createFamilyAccount({
        familyName: body.familyName ?? "",
        password: body.password ?? "",
        parentPin: body.parentPin ?? "",
        deviceLabel: body.deviceLabel,
      });
      const { token, ...safeResult } = result;
      return withTrustedCookie(request, { ok: true, trusted: true, ...safeResult }, token);
    }
    if (body.action === "login") {
      const result = await loginFamily({ familyCode: body.familyCode ?? "", password: body.password ?? "", deviceLabel: body.deviceLabel });
      const { token, ...safeResult } = result;
      return withTrustedCookie(request, { ok: true, trusted: true, ...safeResult }, token);
    }
    if (body.action === "configure-existing") {
      const session = await resolveFamilySession(readCookie(request, DEVICE_COOKIE_NAME));
      if (!session) throw new Error("請先在已信任的裝置操作");
      return privateJson(await configureExistingFamilyAccount({
        familyId: session.familyId,
        familyName: body.familyName ?? "",
        password: body.password ?? "",
        parentPin: body.parentPin,
      }));
    }
    if (body.action === "recover") {
      const recovered = await recoverFamilyPassword({
        familyCode: body.familyCode,
        recoveryCode: body.recoveryCode ?? "",
        newPassword: body.newPassword ?? "",
      });
      return privateJson({ ok: true, ...recovered });
    }
    if (body.action === "recover-with-answers") {
      const result = await recoverFamilyWithSecurityAnswers({
        profileNames: Array.isArray(body.profileNames) ? body.profileNames : [],
        parentPin: body.parentPin ?? "",
        newPassword: body.newPassword ?? "",
        deviceLabel: body.deviceLabel,
      });
      const { token, ...safeResult } = result;
      return withTrustedCookie(request, { ok: true, trusted: true, ...safeResult }, token);
    }
    if (body.action === "logout") {
      await revokeTrustedDeviceByToken(readCookie(request, DEVICE_COOKIE_NAME));
      const response = privateJson({ ok: true });
      response.cookies.set(DEVICE_COOKIE_NAME, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
      return response;
    }
    const session = await resolveFamilySession(readCookie(request, DEVICE_COOKIE_NAME));
    if (!session) throw new Error("請先建立家庭或登入家庭帳本");
    if (body.action === "list") return privateJson({ devices: await listTrustedDevices(session.familyId, body.parentPin) });
    if (body.action === "revoke") {
      await revokeTrustedDevice(session.familyId, body.deviceId ?? "", body.parentPin);
      const response = privateJson({ ok: true });
      if (body.deviceId === session.device.id) response.cookies.set(DEVICE_COOKIE_NAME, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
      return response;
    }
    return privateJson({ error: "不支援的裝置操作" }, { status: 400 });
  } catch (error) {
    return privateJson({ error: error instanceof Error ? error.message : "裝置操作失敗" }, { status: 400 });
  }
}
