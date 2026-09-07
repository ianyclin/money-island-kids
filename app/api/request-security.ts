import { NextResponse } from "next/server";

const PRIVATE_CACHE_CONTROL = "private, no-store, max-age=0";

function appendVaryCookie(headers: Headers): void {
  const vary = headers.get("vary")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean) ?? [];
  if (!vary.some((value) => value.toLowerCase() === "cookie")) vary.push("Cookie");
  headers.set("vary", vary.join(", "));
}

export function applyPrivateResponseHeaders(response: Response): void {
  response.headers.set("cache-control", PRIVATE_CACHE_CONTROL);
  appendVaryCookie(response.headers);
}

export function privateJson(body: unknown, init?: ResponseInit): NextResponse {
  const response = NextResponse.json(body, init);
  applyPrivateResponseHeaders(response);
  return response;
}

export function privateResponseHeaders(initial?: HeadersInit): Headers {
  const headers = new Headers(initial);
  headers.set("cache-control", PRIVATE_CACHE_CONTROL);
  appendVaryCookie(headers);
  return headers;
}

/**
 * Reject browser mutations unless the Origin header exactly matches the
 * request URL's origin. All supported browser form/fetch POSTs send Origin;
 * rejecting a missing header prevents non-browser clients from silently
 * bypassing this CSRF boundary.
 */
export function rejectUntrustedMutationOrigin(request: Request): NextResponse | null {
  const submittedOrigin = request.headers.get("origin");
  if (!submittedOrigin) {
    return privateJson({ error: "無法驗證操作來源，請重新開啟網站後再試" }, { status: 403 });
  }

  try {
    if (new URL(submittedOrigin).origin === new URL(request.url).origin) return null;
  } catch {
    // Invalid and opaque origins are rejected below.
  }
  return privateJson({ error: "這個操作來源未獲允許" }, { status: 403 });
}
